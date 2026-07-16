import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CapabilityAdapter,
  CuratedAdapter,
  CuratedWrite,
  SkillProposal,
} from "../src/adapters";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Events } from "../src/events";
import { remember } from "../src/memory";
import { adapterBinding, drainOnce, type PromoteDeps } from "../src/promote";
import type { ToolCtx } from "../src/tools";
import { exampleVocab } from "./helpers";

const ctx: ToolCtx = { workspace: "/tmp", activate: () => {} };

function adapters() {
  const curatedCalls: CuratedWrite[] = [];
  const capabilityCalls: Array<SkillProposal & { idempotencyKey: string }> = [];
  const curated: CuratedAdapter = {
    binding: "curated-test",
    health: () => "bound",
    propose: async (write) => {
      curatedCalls.push(write);
      return "ok";
    },
  };
  const capability: CapabilityAdapter = {
    binding: "capability-test",
    health: () => "bound",
    search: async () => [],
    get: async () => null,
    propose: async (proposal) => {
      capabilityCalls.push(proposal);
      return "ok";
    },
  };
  return { curated, capability, curatedCalls, capabilityCalls };
}

function deps(
  db: ReturnType<typeof openDb>,
  a: ReturnType<typeof adapters>,
  extra: Partial<PromoteDeps> = {},
): PromoteDeps {
  return {
    db,
    events: new Events(db),
    capability: a.capability,
    curated: a.curated,
    ctx,
    namespace: "test",
    vocab: exampleVocab,
    ...extra,
  };
}

function seed(
  d: PromoteDeps,
  options: {
    source?: "self" | "review";
    trust?: "trusted" | "untrusted";
    runId?: string;
    destination?: "curated" | "capability";
    lifecycle?: "staged" | "claimed";
    claimedAt?: number;
    attempts?: number;
    binding?: string;
  } = {},
) {
  const destination = options.destination ?? "curated";
  const artifactKind = destination === "capability" ? "procedure" : "fact";
  const content =
    destination === "capability" ? "Use the safe deploy flow." : "Cite sources inline.";
  expect(
    remember(d.db, {
      namespace: d.namespace,
      audience: "agent",
      artifactKind,
      content,
      confidence: 0.9,
      trust: options.trust ?? "trusted",
      source: options.source ?? "self",
      runId: options.runId ?? "r1",
    }),
  ).toBe("stored");
  const memory = d.db.query("SELECT id FROM memory").get() as { id: number };
  const now = Date.now();
  const lifecycle = options.lifecycle ?? "staged";
  d.db
    .query(
      `INSERT INTO promotion
         (memory_id, namespace, destination_role, artifact_kind, name, body, content,
          idempotency_key, adapter_binding, lifecycle, claimed_at, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      memory.id,
      d.namespace ?? "default",
      destination,
      artifactKind,
      destination === "capability" ? "safe-deploy" : "",
      destination === "capability" ? "1. Verify\n2. Deploy" : "",
      content,
      `idem-${destination}`,
      options.binding ??
        adapterBinding(d.namespace ?? "default", d.vocab ?? exampleVocab, d.capability, d.curated),
      lifecycle,
      lifecycle === "claimed" ? (options.claimedAt ?? now) : null,
      options.attempts ?? 0,
      now,
      now,
    );
  return memory.id;
}

describe("promotion outbox", () => {
  test("promotion config defaults and clamps the recurrence gate", () => {
    const defaults = loadConfig({});
    expect(defaults.memoryNamespace).toBe("the-record");
    expect(defaults.promoteMinRuns).toBe(2);
    expect(defaults.promoteClaimTtlMs).toBe(60_000);
    const configured = loadConfig({
      DELTA_MEMORY_NAMESPACE: "acme",
      DELTA_PROMOTE_MIN_RUNS: "0",
      DELTA_PROMOTE_CLAIM_TTL_MS: "250",
    });
    expect(configured.memoryNamespace).toBe("acme");
    expect(configured.promoteMinRuns).toBe(1);
    expect(configured.promoteClaimTtlMs).toBe(250);
  });

  test("a trusted review correction is claimed and promoted with its idempotency key", async () => {
    const db = openDb(":memory:");
    const a = adapters();
    const d = deps(db, a);
    seed(d, { source: "review" });

    const out = await drainOnce(d);
    expect(out.claimed).toBe(1);
    expect(out.promoted).toBe(1);
    expect(a.curatedCalls[0]?.idempotencyKey).toBe("idem-curated");
    expect(a.curatedCalls[0]?.content).toContain("sources inline");
    expect(
      (db.query("SELECT lifecycle FROM promotion").get() as { lifecycle: string }).lifecycle,
    ).toBe("promoted");
  });

  test("a capability promotion carries the full staged body", async () => {
    const db = openDb(":memory:");
    const a = adapters();
    const d = deps(db, a);
    seed(d, { source: "review", destination: "capability" });

    await drainOnce(d);
    expect(a.capabilityCalls[0]?.idempotencyKey).toBe("idem-capability");
    expect(a.capabilityCalls[0]?.body).toBe("1. Verify\n2. Deploy");
  });

  test("self learning waits for distinct-run recurrence", async () => {
    const db = openDb(":memory:");
    const a = adapters();
    const d = deps(db, a, { promoteMinRuns: 2 });
    const memoryId = seed(d);
    expect((await drainOnce(d)).claimed).toBe(0);

    expect(
      remember(db, {
        namespace: "test",
        audience: "agent",
        artifactKind: "fact",
        content: "Cite sources inline.",
        confidence: 0.9,
        runId: "r2",
      }),
    ).toBe("duplicate");
    expect((await drainOnce(d)).promoted).toBe(1);
    expect(memoryId).toBeGreaterThan(0);
  });

  test("overlapping drains have one CAS winner and call the adapter once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-promote-"));
    const db = openDb(join(dir, "delta.db"));
    const db2 = openDb(join(dir, "delta.db"));
    const a = adapters();
    let calls = 0;
    a.curated.propose = async () => {
      calls++;
      await Bun.sleep(10);
      return "ok";
    };
    const d = deps(db, a);
    seed(d, { source: "review" });

    try {
      await Promise.all([drainOnce(d), drainOnce({ ...d, db: db2, events: new Events(db2) })]);
      expect(calls).toBe(1);
      expect(
        (db.query("SELECT lifecycle FROM promotion").get() as { lifecycle: string }).lifecycle,
      ).toBe("promoted");
    } finally {
      db.close();
      db2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("untrusted memory is never claimed", async () => {
    const db = openDb(":memory:");
    const a = adapters();
    const d = deps(db, a, { promoteMinRuns: 1 });
    seed(d, { trust: "untrusted" });
    expect((await drainOnce(d)).claimed).toBe(0);
    expect(a.curatedCalls).toHaveLength(0);
  });

  test("adapter failures retry, then become failed and emit an event", async () => {
    const db = openDb(":memory:");
    const a = adapters();
    a.curated.propose = async () => "error";
    const d = deps(db, a, { maxAttempts: 3 });
    seed(d, { source: "review" });

    await drainOnce(d);
    let row = db.query("SELECT lifecycle, attempts FROM promotion").get() as {
      lifecycle: string;
      attempts: number;
    };
    expect(row).toEqual({ lifecycle: "staged", attempts: 1 });
    await drainOnce(d);
    await drainOnce(d);
    row = db.query("SELECT lifecycle, attempts FROM promotion").get() as {
      lifecycle: string;
      attempts: number;
    };
    expect(row).toEqual({ lifecycle: "failed", attempts: 3 });
    expect(
      (
        db.query("SELECT count(*) AS n FROM events WHERE type = 'promotion.failed'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  test("stale claims are reclaimed for a later tick", async () => {
    const db = openDb(":memory:");
    const a = adapters();
    a.curated.health = () => "unbound";
    const d = deps(db, a, { claimTtlMs: 100, now: () => 1_000 });
    seed(d, { source: "review", lifecycle: "claimed", claimedAt: 899, attempts: 1 });

    expect((await drainOnce(d)).reclaimed).toBe(1);
    const row = db.query("SELECT lifecycle, claimed_at FROM promotion").get() as {
      lifecycle: string;
      claimed_at: number | null;
    };
    expect(row).toEqual({ lifecycle: "staged", claimed_at: null });
  });

  test("a different adapter binding is not claimed", async () => {
    const db = openDb(":memory:");
    const a = adapters();
    const d = deps(db, a);
    seed(d, { source: "review", binding: "old-product-binding" });
    expect((await drainOnce(d)).claimed).toBe(0);
    expect(a.curatedCalls).toHaveLength(0);
  });
});
