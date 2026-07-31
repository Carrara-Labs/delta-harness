#!/usr/bin/env bun
import { DeltaAgent } from "./agent";
import { ScheduleControl } from "./control";
import { Connector } from "./core";
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
const connector = new Connector(store, codec, agent, sup, log, allowed);
const ingress = new TelegramLongPoll(token, store, { allowed });
const control = controlUrl
  ? new ScheduleControl(store, controlUrl, controlToken ?? "", () => connector.activeOrigin, log)
  : undefined;

control?.start();
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
