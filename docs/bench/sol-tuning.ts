// Sol parameter tuning for the QS demo shape — effort × verbosity grid on gpt-5.6-sol,
// through Delta's provider layer (reasoning carry + explicit breakpoints + prompt_cache_key
// all active, as they will be on the real lane). Each config runs the same 3-call chain:
//   1. task → must call qs_search
//   2. chunky search results → must call qs_save_artifact with a structured summary
//   3. save confirmed → user-facing update message
// Measured: per-call latency, output tokens (includes reasoning spend), cost, artifact
// correctness (names + numbers survive), update length/quality proxy.
import {
  type ChatMsg,
  chat,
  type ProviderConfig,
} from "/Users/nictouron/delta-harness/src/provider";

const KEY = process.env.OPENAI_KEY ?? "";
if (!KEY) throw new Error("OPENAI_KEY missing");

const SPINE = `You are a Quick Search agent. You find people and companies, verify facts against the data you fetched, and deliver tight, source-grounded briefs.
Rules: never invent data; every claim in an artifact must appear in fetched results; artifacts are structured markdown; user updates are short, confident, and name what was found and where it was saved. ${"Operating notes: prefer primary sources; keep answers short; record what you verified; explicit units; UTC. ".repeat(30)}`;

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "qs_search",
      description: "Search the web and databases for people, companies, funding, and news",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "qs_save_artifact",
      description: "Save a markdown research artifact for the user",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, markdown: { type: "string" } },
        required: ["title", "markdown"],
      },
    },
  },
];

const SEARCH_RESULTS = JSON.stringify({
  results: [
    {
      name: "Maren Kollberg",
      role: "CTO & co-founder",
      company: "Fjordlight Robotics",
      location: "Oslo",
      funding: "$48M Series B (2026-03-12, led by Northzone)",
      note: "ex-DeepMind robotics lead, 2019-2023",
    },
    {
      name: "Fjordlight Robotics",
      employees: 112,
      founded: 2023,
      focus: "warehouse manipulation arms",
      customers: ["Zalando", "Boozt"],
      arr: "$9.4M ARR (Q2 2026)",
    },
    {
      name: "Maren Kollberg — interview",
      source: "TechCrunch 2026-06-02",
      quote: "we ship a new gripper policy weekly",
      detail: "mentions 40% cycle-time reduction at the Zalando pilot",
    },
  ],
  irrelevant: [
    { name: "Maren Kolberg", note: "Norwegian biathlete, unrelated" },
    { name: "Fjordlight AS", note: "lighting retailer, unrelated" },
  ],
});

const TASK =
  "Who is the CTO of Fjordlight Robotics? Get their background, the company's funding and traction, and save me a brief. Then tell me what you found.";

type CallStat = { ms: number; out: number; in: number; cacheRead: number; cost: number };

async function runConfig(
  effort: string | undefined,
  verbosity: "low" | "medium" | "high" | undefined,
  label: string,
) {
  const cfg: ProviderConfig = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: KEY,
    models: ["gpt-5.6-sol"],
    api: "responses",
    maxRetries: 1,
    reasoningSummary: "auto",
    ...(verbosity ? { textVerbosity: verbosity } : {}),
  };
  const cacheKey = `sol-tune-${label}`;
  const messages: ChatMsg[] = [
    { role: "system", content: SPINE },
    { role: "user", content: TASK },
  ];
  const stats: CallStat[] = [];
  const step = async (): Promise<Awaited<ReturnType<typeof chat>>> => {
    const t0 = performance.now();
    const r = await chat(cfg, {
      messages,
      tools: TOOLS,
      cacheKey,
      maxTokens: 8000,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    if (r.ok)
      stats.push({
        ms: Math.round(performance.now() - t0),
        out: r.usage.output,
        in: r.usage.input,
        cacheRead: r.usage.cacheRead,
        cost: r.usage.costUsd,
      });
    return r;
  };

  // call 1: expect qs_search
  const r1 = await step();
  if (!r1.ok) return { label, ok: false, error: r1.error };
  const c1 = r1.message.tool_calls?.[0];
  const call1Searches = r1.message.tool_calls?.length ?? 0;
  if (!c1 || c1.function.name !== "qs_search")
    return { label, ok: false, error: `call1 did ${c1?.function.name ?? "no tool"}` };
  // Parallel searches are normal — EVERY call_id must get a result or the next request 400s.
  messages.push(r1.message);
  for (const tc of r1.message.tool_calls ?? [])
    messages.push({ role: "tool", tool_call_id: tc.id, content: SEARCH_RESULTS });

  // calls 2..N: allow extra search rounds (over-searching is itself a measured behavior),
  // until qs_save_artifact appears. Assistant row FIRST, then its tool results — wire order.
  let artifact = "";
  let extraSearches = 0;
  let saved = false;
  for (let round = 0; round < 4 && !saved; round++) {
    const r = await step();
    if (!r.ok) return { label, ok: false, error: r.error };
    if (!r.message.tool_calls?.length)
      return { label, ok: false, error: "answered without saving an artifact" };
    messages.push(r.message);
    for (const tc of r.message.tool_calls) {
      if (tc.function.name === "qs_save_artifact") {
        saved = true;
        try {
          artifact = String(
            (JSON.parse(tc.function.arguments) as { markdown?: string }).markdown ?? "",
          );
        } catch {}
        messages.push({ role: "tool", tool_call_id: tc.id, content: "saved: brief-fjordlight.md" });
      } else {
        extraSearches++;
        messages.push({ role: "tool", tool_call_id: tc.id, content: SEARCH_RESULTS });
      }
    }
  }
  if (!saved) return { label, ok: false, error: "never saved after 4 rounds" };

  // final call: user-facing update
  const r3 = await step();
  if (!r3.ok) return { label, ok: false, error: r3.error };
  const update = r3.message.content ?? "";

  // correctness: load-bearing facts must survive into the artifact; distractors must not
  const mustHave = ["Maren Kollberg", "48M", "Northzone", "DeepMind", "9.4M", "112"];
  const facts = mustHave.filter((f) => artifact.includes(f)).length;
  const distractor = artifact.includes("biathlete") || artifact.includes("lighting retailer");
  const totals = stats.reduce(
    (a, s) => ({ ms: a.ms + s.ms, out: a.out + s.out, cost: a.cost + s.cost }),
    { ms: 0, out: 0, cost: 0 },
  );
  return {
    label,
    effort: effort ?? "(default)",
    verbosity: verbosity ?? "(default)",
    ok: true,
    facts: `${facts}/${mustHave.length}`,
    searchCalls: call1Searches + extraSearches,
    modelCalls: stats.length,
    distractorLeaked: distractor,
    artifactChars: artifact.length,
    updateChars: update.length,
    update: update.slice(0, 220),
    perCall: stats,
    totalMs: totals.ms,
    totalOut: totals.out,
    totalCost: totals.cost,
  };
}

const grid: Array<[string | undefined, "low" | "medium" | "high" | undefined, string]> = [
  ["none", "low", "none-low"],
  ["low", "low", "low-low"],
  ["low", undefined, "low-defv"],
  ["medium", "low", "medium-low"],
  ["medium", undefined, "medium-defv"],
  ["high", "low", "high-low"],
];

const out: unknown[] = [];
for (const [e, v, l] of grid) {
  try {
    out.push(await runConfig(e, v, l));
  } catch (err) {
    out.push({ label: l, ok: false, error: String(err).slice(0, 200) });
  }
  console.error(`done: ${l}`);
}
console.log(JSON.stringify(out, null, 1));
