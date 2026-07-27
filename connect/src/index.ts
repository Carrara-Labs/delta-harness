#!/usr/bin/env bun
import { Connector } from "./core";
import { DeltaAgent } from "./agent";
import { Store } from "./store";
import { LocalKeepAliveSupervisor } from "./supervisor";
import { TelegramCodec, TelegramLongPoll } from "./telegram";

// Wire the edge: Telegram long-poll -> durable inbox -> agent -> durable
// outbox -> Telegram send. Bun auto-loads ./.env, so the token lives there.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing (set it in connect/.env)");

const baseUrl = process.env.DELTA_BASE_URL ?? "http://127.0.0.1:8080";
const controlToken = process.env.DELTA_CONTROL_TOKEN || undefined;
const dbPath = process.env.CONNECT_DB ?? "connect.sqlite";
const agentName = process.env.DELTA_AGENT_NAME ?? "the agent";
const allowed = new Set(
  (process.env.ALLOWED_TELEGRAM_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const log = (m: string) => console.log(`[delta-connect] ${m}`);

const store = new Store(dbPath);
const codec = new TelegramCodec(token);
const agent = new DeltaAgent(baseUrl, controlToken);
const sup = new LocalKeepAliveSupervisor(baseUrl);
const connector = new Connector(store, codec, agent, sup, log);
const ingress = new TelegramLongPoll(token, store, { allowed });

log(`${agentName} bot up. daemon=${baseUrl} allowlist=${allowed.size > 0 ? [...allowed].join(",") : "open (dev)"}`);

const shutdown = () => {
  log("shutting down");
  ingress.stop();
  connector.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Ingress fills the durable inbox; the connector drains it. Independent loops
// joined only by the inbox table - that decoupling is what lets the agent sleep.
void ingress.start();
void connector.loop();
