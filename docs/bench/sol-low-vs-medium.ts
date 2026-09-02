// Sol low-low vs medium-low on HARD Quick-Search-shaped tasks — the follow-up to
// docs/bench/sol-tuning.ts after its easy tasks showed no effort effect. Three tasks that
// exercise what real QS hard-tier work needs: same-name disambiguation with conflicting
// sources, a three-entity comparison where the third entity requires a SECOND search round
// plus arithmetic, and a gap/staleness trap where the correct answer is "not disclosed".
// n=3 per (task, config). Results are staged BY ROUND (round 1 always returns the partial/
// ambiguous set; round 2+ returns the resolving set), so multi-hop is required, not optional.
import { type ChatMsg, chat, type ProviderConfig } from "../../src/provider";

const KEY = process.env.OPENAI_KEY ?? "";
if (!KEY) throw new Error("OPENAI_KEY missing");

const SPINE = `You are a Quick Search agent. You find people and companies, verify facts against the data you fetched, and deliver tight, source-grounded briefs.
Rules: never invent data; every claim in an artifact must appear in fetched results; when sources conflict, prefer the newer one and SAY there was a conflict; when a fact is not in any result, say "not disclosed" rather than guessing; artifacts are structured markdown; user updates are short and name what was found and where it was saved. ${"Operating notes: prefer primary sources; keep answers short; record what you verified; explicit units; UTC. ".repeat(30)}`;

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

type Task = {
  id: string;
  ask: string;
  round1: string; // partial/ambiguous
  round2: string; // resolving
  mustHave: string[][]; // each inner array = alternatives, one must appear
  mustFlag: string[][]; // conflict/gap language, one alternative must appear
  mustNot: string[]; // distractor leakage
  allowedMoney: string[]; // $-amount roots allowed in the artifact; any other = invention
};

const TASKS: Task[] = [
  {
    id: "disambig",
    ask: "Find the founder and current funding of Helix Dynamics, the robotics company in Munich. Save me a brief, then tell me what you found.",
    round1: JSON.stringify({
      results: [
        {
          name: "Helix Dynamics",
          hq: "Munich",
          sector: "industrial robotics",
          founder: "Jonas Weber",
          note: "founded 2022; funding details not in this index — search funding databases",
        },
        {
          name: "Helix Dynamics",
          hq: "Austin, TX",
          sector: "biotech",
          founder: "Julia Weber",
          funding: "$80M Series C (2025)",
          note: "gene-editing platform — DIFFERENT company, same name",
        },
      ],
    }),
    round2: JSON.stringify({
      results: [
        {
          company: "Helix Dynamics (Munich)",
          round: "$37M Series B",
          date: "2026-05-14",
          lead: "Index Ventures",
          source: "TechCrunch 2026-05-15",
        },
        {
          company: "Helix Dynamics (Munich)",
          round: "$12M Series A",
          date: "2024-09-02",
          lead: "Speedinvest",
          source: "press release (older)",
        },
      ],
    }),
    mustHave: [["Jonas Weber"], ["37M", "37 million"], ["Index Ventures"]],
    mustFlag: [["Austin", "biotech", "same name", "different company", "namesake"]],
    mustNot: ["80M", "gene-editing", "Julia Weber"],
    allowedMoney: ["37", "12", "80"], // 80 may appear ONLY as the flagged other company; leakage is caught by mustNot on facts
  },
  {
    id: "compare",
    ask: "Compare Nordwind AI, Cobalt Loop, and Ferrite Labs on ARR and headcount. Which has the highest ARR per employee? Save a comparison brief, then tell me the answer.",
    round1: JSON.stringify({
      results: [
        { name: "Nordwind AI", arr: "$14.2M ARR (2026)", employees: 88 },
        { name: "Cobalt Loop", arr: "$21M ARR (2026)", employees: 210 },
      ],
      note: "no results for Ferrite Labs in this index — try a direct company search",
    }),
    round2: JSON.stringify({
      results: [
        {
          name: "Ferrite Labs",
          hq: "Copenhagen",
          arr: "$6.3M ARR (2026)",
          employees: 21,
          sector: "ML infrastructure",
        },
        {
          name: "Ferrite Labs",
          hq: "Shenzhen",
          sector: "PCB manufacturing",
          employees: 400,
          note: "DIFFERENT company, same name",
        },
      ],
    }),
    mustHave: [
      ["Ferrite"],
      ["300,000", "300k", "$300", "0.3M", "300 000"],
      ["Nordwind"],
      ["Cobalt"],
    ],
    mustFlag: [],
    mustNot: ["PCB", "Shenzhen manufacturing"],
    allowedMoney: ["14.2", "21", "6.3", "300", "161", "100", "0.3", "0.16", "0.1"],
  },
  {
    id: "gap",
    ask: "What is Veldt Materials' current valuation, and who is their CFO? Save a brief, then tell me.",
    round1: JSON.stringify({
      results: [
        {
          name: "Veldt Materials",
          article: "Sifted, Aug 2024",
          valuation: "$150M (as of Aug 2024)",
          ceo: "Tomas Veldkamp",
          note: "no CFO named in any filing",
        },
      ],
      note: "for current data try recent news",
    }),
    round2: JSON.stringify({
      results: [
        {
          name: "Veldt Materials",
          article: "TechEU, Mar 2026",
          detail: "raised an undisclosed round; valuation not disclosed",
          finance: "company site lists 'Head of Finance: Priya Nair' — no CFO title exists",
        },
      ],
    }),
    mustHave: [["Priya Nair"], ["150M", "150 million"]],
    mustFlag: [
      ["not disclosed", "undisclosed", "no CFO", "does not have a CFO", "no current valuation"],
    ],
    mustNot: ["Tomas Veldkamp is the CFO", "CFO Tomas"],
    allowedMoney: ["150"],
  },
];

type RunOut = Record<string, unknown>;

async function runOnce(task: Task, effort: "low" | "medium", rep: number): Promise<RunOut> {
  const cfg: ProviderConfig = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: KEY,
    models: ["gpt-5.6-sol"],
    api: "responses",
    maxRetries: 1,
    reasoningSummary: "auto",
    textVerbosity: "low",
  };
  const cacheKey = `sol-hard-${task.id}-${effort}-${rep}`;
  const messages: ChatMsg[] = [
    { role: "system", content: SPINE },
    { role: "user", content: task.ask },
  ];
  let ms = 0;
  let out = 0;
  let cost = 0;
  let modelCalls = 0;
  let searchCalls = 0;
  const step = async () => {
    const t0 = performance.now();
    const r = await chat(cfg, {
      messages,
      tools: TOOLS,
      cacheKey,
      maxTokens: 8000,
      reasoningEffort: effort,
    });
    if (r.ok) {
      ms += Math.round(performance.now() - t0);
      out += r.usage.output;
      cost += r.usage.costUsd;
      modelCalls++;
    }
    return r;
  };

  let artifact = "";
  let saved = false;
  let searchRound = 0;
  for (let round = 0; round < 6 && !saved; round++) {
    const r = await step();
    if (!r.ok) return { task: task.id, effort, rep, ok: false, error: r.error };
    if (!r.message.tool_calls?.length)
      return { task: task.id, effort, rep, ok: false, error: "answered without saving" };
    messages.push(r.message);
    let sawSearch = false;
    for (const tc of r.message.tool_calls) {
      if (tc.function.name === "qs_save_artifact") {
        saved = true;
        try {
          artifact = String(
            (JSON.parse(tc.function.arguments) as { markdown?: string }).markdown ?? "",
          );
        } catch {}
        messages.push({ role: "tool", tool_call_id: tc.id, content: `saved: brief-${task.id}.md` });
      } else {
        searchCalls++;
        sawSearch = true;
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: searchRound === 0 ? task.round1 : task.round2,
        });
      }
    }
    if (sawSearch) searchRound++;
  }
  if (!saved) return { task: task.id, effort, rep, ok: false, error: "never saved in 6 rounds" };
  const rFinal = await step();
  if (!rFinal.ok) return { task: task.id, effort, rep, ok: false, error: rFinal.error };
  const update = rFinal.message.content ?? "";
  const all = `${artifact}\n${update}`;

  const factsHit = task.mustHave.filter((alts) => alts.some((a) => all.includes(a))).length;
  const flagsHit = task.mustFlag.filter((alts) =>
    alts.some((a) => all.toLowerCase().includes(a.toLowerCase())),
  ).length;
  const leaks = task.mustNot.filter((m) => artifact.includes(m)).length;
  // Invention scan: $-amounts in the artifact whose numeric root is not in the allowed set.
  const money = [...artifact.matchAll(/\$\s?([\d][\d.,]*)\s?(?:M|B|k|million|billion)?/gi)].map(
    (m) => m[1] ?? "",
  );
  const invented = money.filter(
    (v) => !task.allowedMoney.some((a) => (v ?? "").startsWith(a)),
  ).length;
  return {
    task: task.id,
    effort,
    rep,
    ok: true,
    facts: `${factsHit}/${task.mustHave.length}`,
    flags: `${flagsHit}/${task.mustFlag.length}`,
    leaks,
    inventedMoney: invented,
    searchCalls,
    modelCalls,
    ms,
    out,
    cost,
    updateChars: update.length,
    artifactChars: artifact.length,
    update: update.slice(0, 160),
  };
}

const results: RunOut[] = [];
for (const task of TASKS) {
  for (let rep = 0; rep < 3; rep++) {
    for (const effort of ["low", "medium"] as const) {
      try {
        results.push(await runOnce(task, effort, rep));
      } catch (e) {
        results.push({ task: task.id, effort, rep, ok: false, error: String(e).slice(0, 200) });
      }
      console.error(`done: ${task.id} ${effort} rep${rep}`);
    }
  }
}
console.log(JSON.stringify(results, null, 1));
