#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { DeltaAgent } from "./agent";
import { ScheduleControl } from "./control";
import { Connector } from "./core";
import { IntakeServer, NAME_RE, SESSION_TTL_MS } from "./intake";
import { Store } from "./store";
import { LocalKeepAliveSupervisor, ManagedProcessSupervisor } from "./supervisor";
import { TelegramCodec, TelegramLongPoll } from "./telegram";

// Wire the edge: Telegram long-poll -> durable inbox -> agent -> durable
// outbox -> Telegram send. Bun auto-loads ./.env, so the token lives there.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing (set it in connect/.env)");

const baseUrl = process.env.DELTA_BASE_URL ?? "http://127.0.0.1:8080";
const controlToken = process.env.DELTA_CONTROL_TOKEN || undefined;
const controlUrl = process.env.DELTA_CONTROL_URL || undefined;
const inspectToken = process.env.DELTA_INSPECT_TOKEN || undefined;
const dbPath = process.env.CONNECT_DB ?? "connect.sqlite";
const workspace = process.env.DELTA_WORKSPACE ?? "workspace";
const agentName = process.env.DELTA_AGENT_NAME ?? "the agent";
const allowed = new Set(
  (process.env.ALLOWED_TELEGRAM_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const log = (m: string) => console.log(`[delta-connect] ${m}`);

const store = new Store(dbPath);
const codec = new TelegramCodec(token, workspace);
const agent = new DeltaAgent(baseUrl, controlToken, inspectToken);
const managedEntry = process.env.CONNECT_DAEMON_ENTRY;
const failures = Number(process.env.CONNECT_BOOT_FAILURES);
const sup = managedEntry
  ? new ManagedProcessSupervisor(baseUrl, managedEntry, {
      bootFailures: Number.isInteger(failures) && failures > 0 ? failures : 3,
      log,
    })
  : new LocalKeepAliveSupervisor(baseUrl);
// ── Secure secret intake (0.4.0) ───────────────────────────────────────────────────
// Off unless BOTH a public URL and a port are configured, AND the allowlist is non-empty.
// The chat surface tolerates an open allowlist in development; a credential drop box never
// does — "anyone who has the link" is not a defensible authorization rule.
const publicUrl = process.env.CONNECT_PUBLIC_URL || "";
const publicPort = Number(process.env.CONNECT_PUBLIC_PORT);
const intakeConfigured = Boolean(publicUrl) && Number.isInteger(publicPort) && publicPort > 0;
if (intakeConfigured && allowed.size === 0)
  log(
    "intake DISABLED: ALLOWED_TELEGRAM_USER_IDS is empty, which would let any Telegram user submit a credential",
  );
if (intakeConfigured && !publicUrl.startsWith("https://"))
  log(`intake DISABLED: CONNECT_PUBLIC_URL must be https (got ${publicUrl.split(":")[0]})`);
const intakeOn =
  intakeConfigured && allowed.size > 0 && publicUrl.startsWith("https://") && Boolean(controlToken);
if (intakeConfigured && !controlToken)
  log("intake DISABLED: DELTA_CONTROL_TOKEN is required to write the vault");

const intakeServer = intakeOn
  ? new IntakeServer({
      store,
      botToken: token,
      publicUrl,
      port: publicPort,
      allowedUsers: allowed,
      writeVault: (name, value, purpose) => agent.storeSecret(name, value, purpose),
      log,
      onStored: ({ name, chatId, conversationId, telegramUserId }) => {
        // Confirm by NAME only. Lead with the outcome — the person just handed over a
        // credential and wants to know it landed, not to read a caveat first.
        void codec.send(
          chatId,
          `Success ✅\nThe ${name} was successfully and securely saved - ready for safe use.`,
        );
        // Then tell the AGENT, so it retries whatever it was blocked on. The engine resolves
        // the credential on the next call with no restart, but a tool error already in the
        // thread makes the model avoid that tool for the rest of the conversation.
        store.enqueueNote({
          conversationId,
          // The person who actually submitted — not "whoever is first in the allowlist", which
          // would attribute the turn to the wrong user on a multi-user deployment.
          actorId: `tg:${telegramUserId}`,
          chatId,
          key: `${name}:${Date.now()}`,
          text: `[${name} is now available in your vault and usable immediately - no restart needed. If a task was blocked on it, retry that step now and continue. Otherwise reply in one short line that it is ready.]`,
        });
      },
    })
  : undefined;

/** Mint an intake session, refusing anything the operator has not wired a destination for. */
const mintIntake = async (req: {
  name: string;
  purpose: string;
  chatId: string;
  conversationId: string;
  telegramUserId: string;
}): Promise<{ sessionId: string; destination: string } | { error: string }> => {
  if (!intakeServer) return { error: "secure intake is not configured on this agent" };
  if (!NAME_RE.test(req.name)) return { error: "that is not a valid credential name" };
  if (!allowed.has(req.telegramUserId))
    return { error: "you are not allowed to provide credentials" };
  const state = await agent.vaultState();
  if (!state.enabled) return { error: "the vault is not enabled on this agent" };
  if (state.safeMode) return { error: "the agent is in safe mode" };
  // The operator-sanctioned request set. Without this an injected agent could invent a
  // credential name and talk a human into pasting something nothing is configured to use.
  if (!state.declared.includes(req.name))
    return { error: `nothing on this agent is configured to use ${req.name}` };
  store.sweepIntake();
  const sessionId = randomUUID();
  store.createIntakeSession({
    id: sessionId,
    name: req.name,
    purpose: req.purpose,
    destination: `${agentName}'s vault`,
    telegramUserId: req.telegramUserId,
    chatId: req.chatId,
    conversationId: req.conversationId,
    ttlMs: SESSION_TTL_MS,
  });
  return { sessionId, destination: `${agentName}'s vault` };
};

const connector = new Connector(
  store,
  codec,
  agent,
  sup,
  log,
  allowed,
  intakeServer ? { mint: mintIntake, url: (id) => intakeServer.url(id) } : undefined,
);
const ingress = new TelegramLongPoll(token, store, { allowed });
const control = controlUrl
  ? new ScheduleControl(
      store,
      controlUrl,
      controlToken ?? "",
      (userId) => connector.resolveScheduleOrigin(userId),
      log,
    )
  : undefined;

control?.start();
intakeServer?.start();
if (sup instanceof ManagedProcessSupervisor) {
  const started = await sup.start();
  if (!started.ok) log(`managed daemon boot failed: ${started.error ?? "unknown error"}`);
}

log(
  `${agentName} bot up. daemon=${baseUrl} allowlist=${allowed.size > 0 ? [...allowed].join(",") : "open (dev)"}`,
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("shutting down");
  ingress.stop();
  connector.stop();
  control?.stop();
  intakeServer?.stop();
  await sup.shutdown();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Ingress fills the durable inbox; the connector drains it. Independent loops
// joined only by the inbox table - that decoupling is what lets the agent sleep.
// If EITHER loop rejects, exit non-zero so the supervisor (entrypoint / Fly)
// restarts a clean process instead of limping along half-dead.
const fatal = (where: string) => async (e: unknown) => {
  log(`FATAL ${where}: ${String(e)}`);
  ingress.stop();
  connector.stop();
  control?.stop();
  await sup.shutdown();
  process.exit(1);
};
ingress.start().catch(fatal("ingress"));
connector.loop().catch(fatal("dispatch"));
