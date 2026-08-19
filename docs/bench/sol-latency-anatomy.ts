// Latency anatomy for the sol QS lane — WHERE each model call's wall time goes.
// A fetch-level tap tees the SSE stream and timestamps: request start → response headers
// (network+queue) → first stream event → first REASONING event → first ACTION event (the
// first output item: function_call or message, i.e. "the model starts producing") →
// stream complete. It also reads output_tokens_details.reasoning_tokens from the final
// usage, so thinking spend vs visible-output spend is exact, not inferred.
// Task: the hard disambiguation case from sol-low-vs-medium.ts; arms: effort low vs medium.
import { type ChatMsg, chat, type ProviderConfig } from "../../src/provider";

const KEY = process.env.OPENAI_KEY ?? "";
if (!KEY) throw new Error("OPENAI_KEY missing");

type CallAnatomy = {
  headersMs: number;
  firstEventMs: number;
  firstReasoningMs: number | null;
  firstActionMs: number | null;
  doneMs: number;
  reasoningTokens: number;
  outputTokens: number;
  firstAction: string | null;
};
let current: CallAnatomy | null = null;
const anatomies: CallAnatomy[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const t0 = performance.now();
  const res = await realFetch(url, init);
  const a: CallAnatomy = {
    headersMs: Math.round(performance.now() - t0),
    firstEventMs: 0,
    firstReasoningMs: null,
    firstActionMs: null,
    doneMs: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    firstAction: null,
  };
  current = a;
  anatomies.push(a);
  if (!res.body) return res;
  const [mine, theirs] = res.body.tee();
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    const reader = mine.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!a.firstEventMs) a.firstEventMs = Math.round(performance.now() - t0);
      buf += dec.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const ev = JSON.parse(line.slice(6)) as {
            type?: string;
            item?: { type?: string };
            response?: { usage?: { output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } };
          };
          const t = Math.round(performance.now() - t0);
          if (a.firstReasoningMs === null && ev.type === "response.output_item.added" && ev.item?.type === "reasoning")
            a.firstReasoningMs = t;
          if (a.firstActionMs === null && ev.type === "response.output_item.added" && ev.item?.type !== "reasoning") {
            a.firstActionMs = t;
            a.firstAction = ev.item?.type ?? "?";
          }
          if (ev.type === "response.completed" || ev.type === "response.incomplete") {
            a.doneMs = t;
            a.reasoningTokens = ev.response?.usage?.output_tokens_details?.reasoning_tokens ?? 0;
            a.outputTokens = ev.response?.usage?.output_tokens ?? 0;
          }
        } catch {}
      }
    }
  })().catch(() => {});
  return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
}) as typeof fetch;

const SPINE = `You are a Quick Search agent. You find people and companies, verify facts against the data you fetched, and deliver tight, source-grounded briefs.
Rules: never invent data; when sources conflict, prefer the newer one and SAY there was a conflict; when a fact is not in any result, say "not disclosed"; artifacts are structured markdown; user updates are short. ${"Operating notes: prefer primary sources; keep answers short; record what you verified; explicit units; UTC. ".repeat(30)}`;
const TOOLS = [
  { type: "function" as const, function: { name: "qs_search", description: "Search the web and databases for people, companies, funding, and news", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function" as const, function: { name: "qs_save_artifact", description: "Save a markdown research artifact for the user", parameters: { type: "object", properties: { title: { type: "string" }, markdown: { type: "string" } }, required: ["title", "markdown"] } } },
];
const ROUND1 = JSON.stringify({ results: [
  { name: "Helix Dynamics", hq: "Munich", sector: "industrial robotics", founder: "Jonas Weber", note: "founded 2022; funding details not in this index — search funding databases" },
  { name: "Helix Dynamics", hq: "Austin, TX", sector: "biotech", founder: "Julia Weber", funding: "$80M Series C (2025)", note: "gene-editing platform — DIFFERENT company, same name" },
]});
const ROUND2 = JSON.stringify({ results: [
  { company: "Helix Dynamics (Munich)", round: "$37M Series B", date: "2026-05-14", lead: "Index Ventures", source: "TechCrunch 2026-05-15" },
  { company: "Helix Dynamics (Munich)", round: "$12M Series A", date: "2024-09-02", lead: "Speedinvest", source: "press release (older)" },
]});

async function runInstrumented(effort: "low" | "medium", rep: number) {
  const cfg: ProviderConfig = {
    baseUrl: "https://api.openai.com/v1", apiKey: KEY, models: ["gpt-5.6-sol"], api: "responses",
    maxRetries: 1, reasoningSummary: "auto", textVerbosity: "low",
  };
  const cacheKey = `anatomy-${effort}-${rep}`;
  const messages: ChatMsg[] = [
    { role: "system", content: SPINE },
    { role: "user", content: "Find the founder and current funding of Helix Dynamics, the robotics company in Munich. Save me a brief, then tell me what you found." },
  ];
  const startIdx = anatomies.length;
  const t0 = performance.now();
  let searchRound = 0;
  let saved = false;
  let calls = 0;
  for (let round = 0; round < 7 && !(saved && calls > 0); round++) {
    const r = await chat(cfg, { messages, tools: TOOLS, cacheKey, maxTokens: 8000, reasoningEffort: effort });
    calls++;
    if (!r.ok) return { effort, rep, ok: false, error: r.error };
    if (!r.message.tool_calls?.length) {
      if (saved) break; // the final update
      return { effort, rep, ok: false, error: "answered before saving" };
    }
    messages.push(r.message);
    let sawSearch = false;
    for (const tc of r.message.tool_calls) {
      if (tc.function.name === "qs_save_artifact") { saved = true; messages.push({ role: "tool", tool_call_id: tc.id, content: "saved: brief.md" }); }
      else { sawSearch = true; messages.push({ role: "tool", tool_call_id: tc.id, content: searchRound === 0 ? ROUND1 : ROUND2 }); }
    }
    if (sawSearch) searchRound++;
    if (saved) {
      const rf = await chat(cfg, { messages, tools: TOOLS, cacheKey, maxTokens: 8000, reasoningEffort: effort });
      calls++;
      if (!rf.ok) return { effort, rep, ok: false, error: rf.error };
      break;
    }
  }
  const totalMs = Math.round(performance.now() - t0);
  const mine = anatomies.slice(startIdx);
  return { effort, rep, ok: true, totalMs, calls, perCall: mine };
}

const out: unknown[] = [];
for (const effort of ["low", "medium"] as const)
  for (let rep = 0; rep < 2; rep++) {
    out.push(await runInstrumented(effort, rep));
    console.error(`done ${effort} rep${rep}`);
  }
console.log(JSON.stringify(out, null, 1));
