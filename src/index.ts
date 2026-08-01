#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Entry. Two modes: daemon (default — serve the seam) and `delta run "<task>"`
// (oneshot — execute one run and print the answer; spawn_subagent uses this to
// give side-quests their own context in a child of the same binary).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import cockpitHtml from "../assets/cockpit.html" with { type: "text" };
import { builtinTools } from "./builtins";
import { FIXED_OPERATOR_FILES, SELF_FILE } from "./bundle";
import { cliBundle, cliDev, cliInit, cliSend, cliWatch } from "./cli";
import { type Config, devConfigView, loadConfig } from "./config";
import { openDb } from "./db";
import { Events } from "./events";
import { Exporter } from "./exporter";
import { sweepTrash } from "./files";
import { acquireLease, releaseLease, renewLease } from "./lease";
import { LocalSkillsAdapter } from "./local-skills";
import { McpRegistry } from "./mcp";
import { fileRefreshStore, RefreshingMcpCredential } from "./mcp-refresh";
import { loadPolicy } from "./policy";
import { loadPromptContext, renderTemplate, stableVars } from "./promptcontext";
import { chatVia, markWireSuspect, warmupWire } from "./provider";
import { Queue } from "./queue";
import { pruneLocalState } from "./retention";
import type { Deps } from "./run";
import { loadSelf } from "./self";
import { createServer } from "./server";
import { stripSkillRegistryTools } from "./skill-registry";
import { elide, testTools } from "./tools";
import { declaredNames, Vault } from "./vault";
import { HARNESS_VERSION } from "./version";

function selfCmd(): string[] {
  // Under `bun src/index.ts` re-invoke via bun + script; as a compiled binary,
  // the binary IS the runtime.
  return process.execPath.endsWith("bun") ? [process.execPath, Bun.main] : [process.execPath];
}

function buildDeps(cfg: Config, dbPath: string): Deps {
  const db = openDb(dbPath);
  // The vault opens on the daemon DB before any tool exists: null when DELTA_VAULT_KEY is
  // unset or in safe mode, and every vault surface then simply isn't there (fail-safe).
  const vault = Vault.open(db, cfg.vaultKey, cfg.safeMode);
  const tools = builtinTools({
    workspace: cfg.workspace,
    vision: cfg.vision,
    ...(cfg.exaKey ? { exaKey: cfg.exaKey } : {}),
    fetchAllowPrivate: cfg.fetchAllowPrivate,
    codeCli: cfg.codeCli,
    selfCmd: selfCmd(),
    subagentDepth: cfg.subagentDepth,
    ...(cfg.controlUrl ? { controlUrl: cfg.controlUrl } : {}),
    ...(cfg.controlToken ? { controlToken: cfg.controlToken } : {}),
    vault,
  });
  if (process.env.DELTA_TEST_TOOLS) for (const [n, t] of testTools()) tools.set(n, t);
  const chat = (req: Parameters<typeof chatVia>[1]) => chatVia(cfg.providers, req);
  // Utility lane: same providers, cheap model. The Anthropic-native wire wants a bare DASHED id
  // ("claude-haiku-4-5", not "anthropic/claude-haiku-4.5"); that translation now lives once in
  // streamAnthropic (A9), so the same utility slug flows to every provider. The OpenAI-Responses
  // subscription backend can't serve a Claude slug at all, so responses-API providers are skipped
  // rather than burning a guaranteed-4xx roundtrip on every aux call. Any failure still falls back
  // to the main cascade — the lane can only ever save money, never lose a call.
  const utilityIsClaude = /claude/i.test(cfg.utilityModel);
  const utilityProviders = cfg.utilityModel
    ? cfg.providers
        .filter((p) => !(p.api === "responses" && utilityIsClaude))
        .map((p) => ({ ...p, models: [cfg.utilityModel] }))
    : [];
  const chatUtility = utilityProviders.length
    ? async (req: Parameters<typeof chatVia>[1]) => {
        const res = await chatVia(utilityProviders, req);
        return res.ok || res.aborted ? res : chat(req);
      }
    : undefined;
  return {
    db,
    events: new Events(db, cfg.agentId ? { agentId: cfg.agentId } : {}),
    chat,
    ...(chatUtility ? { chatUtility } : {}),
    tools,
    workspace: cfg.workspace,
    profile: cfg.profile,
    safeMode: cfg.safeMode,
    allowSelfWrite: cfg.allowSelfWrite,
    compactAtTokens: cfg.compactAtTokens,
    toolTimeoutMs: cfg.toolTimeoutMs,
    toolResultCap: cfg.toolResultCap,
    hydrateTools: cfg.hydrateTools,
    ...(cfg.hydrateSearchTool ? { hydrateSearchTool: cfg.hydrateSearchTool } : {}),
    reflect: cfg.reflect,
    vocab: cfg.vocab,
    memoryNamespace: cfg.memoryNamespace,
    isolateAgentMemory: cfg.isolateAgentMemory,
    promoteMinRuns: cfg.promoteMinRuns,
    promoteClaimTtlMs: cfg.promoteClaimTtlMs,
    capabilitySearchK: cfg.capabilitySearchK,
    skills: cfg.skills,
    ...(cfg.skills === "local" ? { capability: new LocalSkillsAdapter(cfg.workspace) } : {}),
    ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
    vision: cfg.vision,
    ...(cfg.agentId ? { agentId: cfg.agentId } : {}),
    // DELTA.md self-write byte cap (bytes ≈ tokens*4) — used by the run's `remember`
    // capability so the always-on self-file can't grow the spine unbounded.
    selfMaxBytes: cfg.selfMaxTokens * 4,
    // Cockpit true-to-life per-call capture — dev-only (delta dev enables it).
    ...(process.env.DELTA_CAPTURE_CALLS === "1" ? { captureCalls: true } : {}),
    ...(vault ? { vault } : {}),
  };
}

/** Load the bundle's two markdown layers at boot. POLICY.md (the fixed contract) is a
 * true boot snapshot on deps — it never changes for the daemon's life. DELTA.md (the
 * writable self-file) is also snapshotted here for reflection's success rubric, but the
 * SPINE reads its own run-local snapshot each run (run.ts), so a self-edit takes effect
 * next run. A missing DELTA.md is fine (the neutral base persona stands); an oversized
 * POLICY.md throws (fail boot — a fixed rule is never elided). */
async function loadIdentity(deps: Deps, cfg: Config): Promise<void> {
  deps.primaryModel = cfg.provider.models[0];
  if (cfg.safeMode) return;
  const self = await loadSelf(cfg.workspace, cfg.selfMaxTokens);
  if (self.charter.persona || self.charter.mission || self.charter.success)
    deps.charter = self.charter;
  deps.policy = await loadPolicy(cfg.workspace, cfg.policyMaxTokens);
  // Dynamic prompt context (PROMPT_CONTEXT.md): render the boot-stable block once now (it
  // rides the cached spine); keep the ## Turn template to render per turn (run.ts). The
  // primary model id feeds {{model}} in the turn block.
  const context = await loadPromptContext(cfg.workspace);
  if (context.stable)
    // Cap the rendered stable block (codex #4) so a large PROMPT_CONTEXT can't bloat the
    // cached <2k spine — same treatment the per-turn block gets in run.ts.
    deps.contextStable = elide(
      renderTemplate(
        context.stable,
        stableVars({
          engineVersion: HARNESS_VERSION,
          ...(cfg.agentId ? { agentId: cfg.agentId } : {}),
          profile: cfg.profile,
        }),
      ).trim(),
      2_000,
    );
  if (context.turn) deps.contextTurn = context.turn;
}

// Local conveniences (spec §2–3), handled before any daemon boot. `dev` spawns the
// ordinary daemon as a child; `send` is a pure HTTP client — neither opens the DB or
// takes the lease, so they never contend with a running agent.
if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  const { HARNESS_VERSION } = await import("./version");
  console.log(HARNESS_VERSION);
  process.exit(0);
}
if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  console.log(`delta — a lean, product-neutral operator harness

Usage:
  delta                 start the daemon (serve the seam on $PORT, default 8080)
  delta init <dir>      scaffold a bundle
  delta dev <dir>       boot a bundle in the local Cockpit
  delta run "<task>"    execute one task and print the answer
  delta bundle apply    re-seed the fixed bundle files (POLICY/vocab/context) from
                        their base64 env — never DELTA.md
  delta --version       print the version

Docs: https://deltaharness.dev`);
  process.exit(0);
}
if (process.argv[2] === "init") process.exit(await cliInit(process.argv.slice(3)));
if (process.argv[2] === "dev") process.exit(await cliDev(process.argv.slice(3), selfCmd()));
if (process.argv[2] === "send") process.exit(await cliSend(process.argv.slice(3)));
if (process.argv[2] === "watch") process.exit(await cliWatch(process.argv.slice(3)));

const cfg = loadConfig();

if (process.argv[2] === "bundle") process.exit(await cliBundle(process.argv.slice(3), cfg));

if (process.argv[2] === "run") {
  // Oneshot: fresh in-memory state, one run, answer on stdout, exit code = status.
  const task = process.argv.slice(3).join(" ").trim();
  if (!task) {
    console.error("usage: delta run <task>");
    process.exit(2);
  }
  const deps = buildDeps(cfg, ":memory:");
  await loadIdentity(deps, cfg); // DELTA.md self-file + POLICY.md contract
  const queue = new Queue(deps);
  const done = await queue.wait(queue.enqueue({ input: task }).id);
  console.log(JSON.parse(done.result ?? "{}").output_text ?? "");
  console.error(`\nDELTA_USAGE ${done.usage ?? JSON.stringify({})}`);
  process.exit(done.status === "done" ? 0 : 1);
}

mkdirSync(dirname(cfg.dbPath), { recursive: true });
mkdirSync(cfg.workspace, { recursive: true });
let deps: Deps;
try {
  deps = buildDeps(cfg, cfg.dbPath);
} catch (error) {
  console.error(`delta: could not open database ${cfg.dbPath} — ${String(error)}`);
  process.exit(1);
}

const leaseHolder = cfg.leaseHolder;
if (!acquireLease(deps.db, leaseHolder, cfg.leaseTtlMs)) {
  console.error(
    `delta: another daemon holds the write lease on ${cfg.dbPath} — refusing to start a second writer`,
  );
  try {
    deps.db.close();
  } catch {}
  process.exit(1);
}

let mcp: McpRegistry | undefined;
let server: ReturnType<typeof createServer> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let retentionTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
const shutdown = (code: number, relinquish = true): void => {
  if (stopping) return;
  stopping = true;
  if (heartbeat) clearInterval(heartbeat);
  if (retentionTimer) clearInterval(retentionTimer);
  if (relinquish) releaseLease(deps.db, leaseHolder);
  try {
    mcp?.closeAll();
  } catch {}
  try {
    server?.stop(true);
  } catch {}
  try {
    deps.db.close();
  } catch {}
  process.exit(code);
};

const beatMs = Math.floor(cfg.leaseTtlMs / 3);
let lastBeat = Date.now();
let rewarmedAt = 0;
heartbeat = setInterval(() => {
  // Suspend/resume detector: this interval cannot tick while the VM is frozen, so a
  // wall-clock gap far beyond the cadence means we likely woke from a suspend (or sat
  // through a hard event-loop stall — same remedy). The keep-alive sockets in the fetch
  // pool are dead behind a gone NAT path after a resume: mark the wire suspect (fresh
  // sockets for the next 2 min — the hard guarantee) and rewarm in the background
  // (single-flight + 60s cooldown, so stall storms can't amplify into probe storms).
  const gapMs = Date.now() - lastBeat;
  lastBeat = Date.now();
  if (gapMs > Math.max(beatMs * 3, 60_000) && Date.now() - rewarmedAt > 60_000) {
    rewarmedAt = Date.now();
    console.error(
      `delta: heartbeat gap ${Math.round(gapMs / 1000)}s (suspend/resume or stall) — refreshing provider wire`,
    );
    markWireSuspect();
    void warmupWire(cfg.providers);
  }
  // Renew our lease; if renewal fails because it lapsed — the classic case is a Fly
  // suspend/resume across a wall-clock jump that pushed expires_at into the past while
  // the VM (and this interval) were frozen — try to REACQUIRE our own machine-scoped
  // lease before giving up. acquireLease's "expires_at <= now OR holder_id = me" branch
  // reclaims an expired-or-own lease atomically, so we recover from suspend instead of
  // exiting into Fly's restart-cap stall. This is RECOVERY, not fencing (the lease is
  // unfenced and machine-scoped, see lease.ts): we exit only when a *different* live
  // holder genuinely owns a non-expired lease — real split-brain, the one case worth
  // dying for. A duplicate holder id across machines still defeats this (documented).
  if (
    renewLease(deps.db, leaseHolder, cfg.leaseTtlMs) ||
    acquireLease(deps.db, leaseHolder, cfg.leaseTtlMs)
  )
    return;
  console.error(
    `delta: write lease held by a different live holder on ${cfg.dbPath} — exiting to avoid concurrent writes`,
  );
  shutdown(1, false);
}, beatMs);
process.once("SIGTERM", () => shutdown(0));
process.once("SIGINT", () => shutdown(0));

// Attach a refreshing agent credential to a named MCP server (§E / G6b) when a token
// endpoint + a rotating-refresh file + the target server name are provisioned (seeded
// from a Fly secret). The one-shot token never rides in the plain MCP JSON config.
// Product-neutral: a product points DELTA_MCP_REFRESH_SERVER at its own backend.
// The required trio to attach the credential; the wider set catches a lone stray var
// (a TOKEN/CLIENT_ID with no URL) so a half-configured refresh warns instead of no-oping.
if (!cfg.safeMode) {
  const refreshRequired = [
    process.env.DELTA_MCP_REFRESH_URL,
    process.env.DELTA_MCP_REFRESH_FILE,
    process.env.DELTA_MCP_REFRESH_SERVER,
  ];
  const refreshAny =
    refreshRequired.some(Boolean) ||
    Boolean(process.env.DELTA_MCP_REFRESH_TOKEN) ||
    Boolean(process.env.DELTA_MCP_REFRESH_CLIENT_ID);
  if (refreshRequired.every(Boolean)) {
    const serverName = process.env.DELTA_MCP_REFRESH_SERVER;
    const credential = new RefreshingMcpCredential({
      tokenUrl: process.env.DELTA_MCP_REFRESH_URL as string,
      clientId: process.env.DELTA_MCP_REFRESH_CLIENT_ID ?? "delta-agent",
      ...fileRefreshStore(
        process.env.DELTA_MCP_REFRESH_FILE as string,
        process.env.DELTA_MCP_REFRESH_TOKEN,
      ),
    });
    let attached = 0;
    for (const s of cfg.mcpServers) {
      if (s.transport === "http" && s.name === serverName) {
        s.credential = credential;
        attached++;
      }
    }
    // Don't fail silently: a provisioning typo (wrong server name) leaves the MCP calls
    // unauthenticated, which surfaces later as opaque 401s — say so at boot instead.
    if (!attached)
      console.error(
        `delta: DELTA_MCP_REFRESH_SERVER='${serverName}' matched no http MCP server — refresh credential NOT attached.`,
      );
  } else if (refreshAny) {
    console.error(
      "delta: partial DELTA_MCP_REFRESH_* config — need URL + FILE + SERVER together. Refresh credential NOT attached.",
    );
  }

  // Connect configured MCP servers (spec §D). Their tools fold into the registry
  // and appear in the tool directory. A failing server is logged, never fatal.
  mcp = new McpRegistry(deps.tools, deps.vault ?? null);
  for (const server of cfg.mcpServers) {
    const r = await mcp.add(server);
    console.log(
      r.ok ? `mcp: ${server.name} → ${r.tools} tools` : `mcp: ${server.name} failed — ${r.error}`,
    );
  }
}

if (cfg.skills !== "mcp") stripSkillRegistryTools(deps.tools);

await loadIdentity(deps, cfg); // DELTA.md self-file + POLICY.md contract

const queue = new Queue(deps, cfg.maxConcurrency);
// Bind the port BEFORE resuming any work. On a single machine the port is the real
// second-writer guard: the lease is machine-scoped, so a same-machine double-start
// self-reacquires it (that path is what lets a crashed daemon's restart reclaim
// instantly). Binding here — ahead of queue.recover(), which resumes runs that fire
// model/tool/knowledge-base calls — closes the window where two same-machine daemons both do
// write-work before the loser discovers the occupied port (codex P1). The loser exits
// WITHOUT releasing: the live sibling holds the same machine-scoped lease and renews it.
try {
  server = createServer(queue, deps.events, cfg.port, {
    workspace: cfg.workspace,
    // The VM's own gateway token doubles as the inbound credential — the control
    // plane already sends it as a Bearer on every daemon call (codex S8 #1).
    ...(cfg.controlToken ? { authToken: cfg.controlToken } : {}),
    // Cockpit (spec §4): compiled into every binary. The inspect token is a DISTINCT,
    // higher privilege than driving runs; unset ⇒ /v1/dev/* is loopback-only.
    ...(process.env.DELTA_INSPECT_TOKEN ? { inspectToken: process.env.DELTA_INSPECT_TOKEN } : {}),
    ...(process.env.DELTA_BIND ? { hostname: process.env.DELTA_BIND } : {}),
    ...(process.env.DELTA_INSPECT === "off" ? { inspectDisabled: true } : {}),
    ...(process.env.DELTA_INSPECT_WRITE === "1" ? { inspectWrite: true } : {}),
    ...(cfg.strictTenant ? { strictTenant: true } : {}),
    ...(cfg.trustReviewMetadata ? { trustReviewMetadata: true } : {}),
    db: deps.db,
    // Exact-name allowlist for /v1/dev/files?path=operator/<name> — the bundle's
    // viewable files (the self-file + the fixed operator files).
    operatorFiles: [SELF_FILE, ...FIXED_OPERATOR_FILES],
    selfMaxBytes: cfg.selfMaxTokens * 4,
    config: devConfigView(cfg, [...deps.tools.keys()]),
    // Vault: the live instance (status reads it per request, so a secret provided a minute
    // ago is visible) plus the names config declares a destination for.
    ...(deps.vault ? { vault: deps.vault } : {}),
    vaultDeclared: declaredNames(cfg.mcpServers, cfg.exaKey ? [] : ["EXA_API_KEY"]),
    // A backend whose credential was missing at boot never connected. When that credential
    // arrives, reconnect exactly the servers that reference it — so handing an agent a key
    // mid-conversation actually lights the backend up, with no restart.
    onSecretStored: (name) => {
      for (const server of cfg.mcpServers) {
        if (!declaredNames([server]).includes(name)) continue;
        void mcp?.add(server).then((r) => {
          console.error(
            r.ok
              ? `mcp: ${server.name} reconnected with ${name} (${r.tools} tools)`
              : `mcp: ${server.name} still failing after ${name} arrived — ${r.error}`,
          );
        });
      }
    },
    // `with { type: "text" }` makes this a string at runtime (and embeds it in the
    // compiled binary); bun-types still widens a `.html` import to HTMLBundle, so cast.
    cockpitHtml: cockpitHtml as unknown as string,
  });
} catch (error) {
  console.error(
    `delta: port ${cfg.port} is already bound — another daemon on this machine is live; exiting (${String(error)})`,
  );
  if (heartbeat) clearInterval(heartbeat);
  try {
    mcp?.closeAll();
  } catch {}
  try {
    deps.db.close();
  } catch {}
  process.exit(1);
}
queue.recover(); // resume mid-flight runs only after we own BOTH the lease and the port
// Pay DNS + TLS to every provider origin off the first turn's critical path. Boot-time
// counterpart of the resume warmup in the heartbeat below. Fire-and-forget by contract.
void warmupWire(cfg.providers);
if (cfg.telemetryUrl) {
  // Collector credential: a dedicated TELEMETRY_TOKEN when provisioned, else the
  // VM's own gateway token — the CP's ingest self-auths by its hash (the same
  // pattern as self-scheduling), so no separate telemetry credential needs minting.
  const telemetryAuth = cfg.telemetryToken ?? cfg.controlToken;
  new Exporter(deps.db, {
    url: cfg.telemetryUrl,
    capturePayloads: cfg.capturePayloads,
    ...(telemetryAuth ? { authToken: telemetryAuth } : {}),
  }).start();
}
sweepTrash(cfg.workspace); // Sprint 8: trashed files past 7 days are gone for good
// Local diagnostic-state retention (events + journal): runs regardless of telemetry —
// the Exporter only bounds `events` when telemetry is wired, and nothing bounds `journal`,
// so a telemetry-less daemon would otherwise grow both without limit. Sweep once at boot,
// then on an interval. When telemetry IS on, the sweep leaves `events` to the Exporter.
const telemetryActive = Boolean(cfg.telemetryUrl);
const runRetentionSweep = () =>
  pruneLocalState(deps.db, {
    now: Date.now(),
    retentionMs: cfg.retentionMs,
    maxEvents: cfg.retentionMaxEvents,
    maxJournal: cfg.retentionMaxJournal,
    telemetryActive,
  });
runRetentionSweep();
if (cfg.retentionSweepMs > 0) {
  retentionTimer = setInterval(runRetentionSweep, cfg.retentionSweepMs);
  retentionTimer.unref?.(); // a pending sweep must never hold the process open
}
console.log(
  `delta listening on :${server.port} · db ${cfg.dbPath} · workspace ${cfg.workspace}${cfg.safeMode ? " · SAFE MODE" : ""} · providers ${cfg.providers.map((p) => p.label ?? p.baseUrl).join(" → ")} · models ${cfg.provider.models.join(" → ")}${cfg.telemetryUrl ? ` · telemetry → ${cfg.telemetryUrl}` : ""}`,
);
