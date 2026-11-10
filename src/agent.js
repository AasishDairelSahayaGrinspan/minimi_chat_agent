// The answer engine: routing, orchestration and answer composition.
//
// Every message takes exactly one of four routes:
//   1. memory     - "what did I ask on 3 November?" Answered from stored
//                   turns only. No search: the past cannot be re-searched.
//   2. search     - a fresh question. One web search, answer from results.
//   3. compare    - "has pricing changed since I asked?" Retrieve the old
//                   turn, run a FRESH search, compare the stored fact
//                   snapshot against the new results, and say plainly
//                   what changed and what could not be confirmed.
//   4. chat       - greetings and small talk. No tool, no memory lookup.
//
// The orchestration is plain code on purpose: the routing decisions are
// the interesting part of this agent, so they are readable here instead
// of hidden inside a framework or a model tool-call loop.
// Budget rule: at most 2 search calls per question (the original query
// plus one rewritten query, which in compare route is the original
// past question).

import { config } from "./config.js";
import { searchWeb } from "./search.js";
import { findRelevantTurns, addTurn } from "./memory.js";
import { buildSnapshot, compareFacts, extractFacts } from "./extract.js";

const MEMORY_INTENT =
  /what did i (ask|say)|did i ask|i asked you|we (asked|discussed|shortlisted|talked|looked)|you (told|said|recommended)|earlier|previously|remember when|last time/i;
const COMPARISON_INTENT =
  /changed|change since|still correct|still true|still valid|any update|updates? since|news since|shipped|since then|since i asked|price now|pricing now/i;
const SEARCH_INTENT =
  /price|pricing|cost|how much|latest|current|news|today|best|compare|which|who|when|release|version|review|worth|should i|what is|what are|tell me about/i;
const SMALL_TALK =
  /^\s*(hi|hii+|hello|hey|yo|thanks|thank you|thx|bye|good (morning|afternoon|evening)|how are you|ok|okay|cool|nice|great)\W*\s*$/i;

function dedupeSources(results) {
  const seen = new Set();
  return results
    .filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .slice(0, 6);
}

function formatResultsForPrompt(results) {
  return results
    .slice(0, 5)
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}${r.publishedDate ? ` (published ${r.publishedDate})` : ""}\nURL: ${r.url}\n${r.snippet}`
    )
    .join("\n\n");
}

function formatTurnsForPrompt(turns) {
  return turns
    .map(
      (t) =>
        `- On ${t.dateLocal} the user asked: "${t.question}"\n  Answer given then: ${t.answer.slice(0, 600)}\n  Facts snapshot from then: prices [${(t.snapshot?.money || []).join(", ") || "none"}], versions [${(t.snapshot?.versions || []).join(", ") || "none"}]`
    )
    .join("\n");
}

// --- LLM composition (used only when OPENAI_API_KEY is set) --------------
async function callLlm(system, user) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM call failed with HTTP ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("LLM returned an empty answer");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT =
  "You are a helpful chat agent with web search and a memory of this conversation. " +
  "Answer in a natural, concise way. Cite web sources inline like [1], [2] using the numbering given. " +
  "Mention dates when they matter. Never invent facts that are not in the memory or the search results. " +
  "For comparison questions, structure the answer with what changed and what is unchanged or could not be confirmed, " +
  "based only on the comparison data provided. If fresh results cannot confirm an old fact, say so honestly.";

// --- Extractive fallback (no LLM key) --------------------------------------
// Not a fake LLM: it openly says it is running without one and composes
// the answer directly from the top results, with citations.
function extractiveSearchAnswer(query, results) {
  const facts = extractFacts(results.map((r) => r.snippet).join(" "));
  const lines = [
    `Here is what I found for "${query}". (I am running without an LLM key, so this is a direct summary of the top search results rather than a written-out answer.)`,
    "",
  ];
  results.slice(0, 5).forEach((r, i) => {
    const when = r.publishedDate ? ` (${r.publishedDate})` : "";
    lines.push(`${i + 1}. ${r.title}${when}: ${r.snippet.slice(0, 280)} [${i + 1}]`);
  });
  const factBits = [
    ...facts.money.map((m) => `price seen: ${m}`),
    ...facts.versions.map((v) => `version seen: ${v}`),
  ];
  if (factBits.length) lines.push("", `Concrete figures in these results: ${factBits.join("; ")}.`);
  return lines.join("\n");
}

function extractiveMemoryAnswer(turns, reference) {
  const lines = [];
  if (reference) lines.push(`You are referring to ${reference.label}.`);
  if (!turns.length) {
    lines.push("I have no record of a conversation matching that in this chat history.");
    return lines.join("\n");
  }
  for (const t of turns) {
    lines.push(
      `On ${t.dateLocal} you asked: "${t.question}"`,
      `My answer then was: ${t.answer.slice(0, 500)}`,
      ""
    );
  }
  return lines.join("\n").trim();
}

function extractiveCompareAnswer(turn, results, comparison) {
  const lines = [
    `On ${turn.dateLocal} you asked: "${turn.question}"`,
    `Facts I recorded then: prices [${(turn.snapshot?.money || []).join(", ") || "none"}], versions [${(turn.snapshot?.versions || []).join(", ") || "none"}].`,
    "",
    "I ran a fresh search just now. Top findings:",
  ];
  results.slice(0, 5).forEach((r, i) => {
    const when = r.publishedDate ? ` (${r.publishedDate})` : "";
    lines.push(`${i + 1}. ${r.title}${when}: ${r.snippet.slice(0, 240)} [${i + 1}]`);
  });
  lines.push("", "Changed (values appearing in fresh results that were not in the old snapshot):");
  lines.push(comparison.changed.length ? comparison.changed.map((c) => `- ${c}`).join("\n") : "- Nothing clearly new surfaced.");
  lines.push("", "Unchanged (old values confirmed again in fresh results):");
  lines.push(comparison.unchanged.length ? comparison.unchanged.map((c) => `- ${c}`).join("\n") : "- None of the old values were directly reconfirmed.");
  lines.push("", "Could not confirm (old values not seen in fresh results; this can mean they changed, or that the fresh results simply did not mention them):");
  lines.push(comparison.unconfirmed.length ? comparison.unconfirmed.map((c) => `- ${c}`).join("\n") : "- Nothing outstanding.");
  lines.push("", "Note: I am running without an LLM key, so this comparison is a direct snapshot diff. A new value can also be a different plan or tier in the results, so treat the Changed list as leads to check, not proof.");
  return lines.join("\n");
}

// --- Main entry point -------------------------------------------------------
export async function handleMessage(conversationId, message) {
  const text = String(message || "").trim();
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const retrieval = findRelevantTurns(conversationId, text);
  const matched = retrieval.turns;
  const wantsMemory = MEMORY_INTENT.test(text) || retrieval.byDate || COMPARISON_INTENT.test(text);
  const wantsComparison = COMPARISON_INTENT.test(text) && matched.length > 0;
  const wantsSearch = SEARCH_INTENT.test(text);

  let route;
  let answer;
  let sources = [];
  let searchCalls = 0;

  const doSearch = async (query) => {
    if (searchCalls >= 2) return [];
    searchCalls += 1;
    try {
      return await searchWeb(query);
    } catch {
      return [];
    }
  };

  if (wantsComparison) {
    // Route 3: memory + fresh search comparison.
    route = "compare";
    const turn = matched[0];
    // Search on the ORIGINAL past questions, never on the user's meta
    // question ("what did I ask on 3 November?" searched literally
    // returns grammar sites, not Notion pricing). Budget: at most 2
    // searches, so a second matched turn's question is the second call.
    const freshA = await doSearch(turn.question);
    const freshB = matched[1] ? await doSearch(matched[1].question) : [];
    sources = dedupeSources([...freshA, ...freshB]);
    const freshText = sources.map((s) => `${s.title} ${s.snippet}`).join("\n");
    // Merge snapshots when several turns matched (for example a whole
    // shortlist conversation), so the comparison covers all of them.
    const mergedSnapshot = {
      money: [...new Set(matched.flatMap((t) => t.snapshot?.money || []))],
      versions: [...new Set(matched.flatMap((t) => t.snapshot?.versions || []))],
      percents: [...new Set(matched.flatMap((t) => t.snapshot?.percents || []))],
    };
    const comparison = compareFacts(mergedSnapshot, freshText);

    if (!sources.length) {
      answer =
        extractiveMemoryAnswer(matched, retrieval.reference) +
        "\n\nI tried a fresh search to check for changes, but search returned nothing usable just now, so I cannot honestly say whether anything has changed.";
    } else if (config.openaiApiKey) {
      try {
        answer = await callLlm(
          SYSTEM_PROMPT,
          `Today is ${today}.\n\nMemory (past turns):\n${formatTurnsForPrompt(matched)}\n\nSnapshot comparison (old snapshot vs fresh results):\nChanged: ${comparison.changed.join("; ") || "none"}\nUnchanged: ${comparison.unchanged.join("; ") || "none"}\nCould not confirm: ${comparison.unconfirmed.join("; ") || "none"}\n\nFresh search results:\n${formatResultsForPrompt(sources)}\n\nUser question: ${text}\n\nAnswer the question: recall what was said then, then say what has changed and what has not, using the comparison data.`
        );
      } catch {
        answer = extractiveCompareAnswer(turn, sources, comparison);
      }
    } else {
      answer = extractiveCompareAnswer(turn, sources, comparison);
    }
  } else if (wantsMemory && matched.length) {
    // Route 1: memory only.
    route = "memory";
    if (config.openaiApiKey) {
      try {
        answer = await callLlm(
          SYSTEM_PROMPT,
          `Today is ${today}.\n\nMemory (past turns from this conversation):\n${formatTurnsForPrompt(matched)}\n\nUser question: ${text}\n\nAnswer only from the memory above. Give the date of the past conversation.`
        );
      } catch {
        answer = extractiveMemoryAnswer(matched, retrieval.reference);
      }
    } else {
      answer = extractiveMemoryAnswer(matched, retrieval.reference);
    }
  } else if (wantsMemory && !matched.length) {
    // Asked about the past, but there is no matching record. Be honest,
    // and still be useful: if the question also carries a fresh topic,
    // search for that.
    route = "memory";
    answer = retrieval.reference
      ? `I have no record of a conversation on ${retrieval.reference.label} in this chat history.`
      : "I have no record of a conversation matching that in this chat history.";
    if (wantsSearch) {
      const results = dedupeSources(await doSearch(text));
      if (results.length) {
        sources = results;
        route = "search";
        const fresh = config.openaiApiKey
          ? await callLlm(
              SYSTEM_PROMPT,
              `Today is ${today}.\n\nSearch results:\n${formatResultsForPrompt(results)}\n\nUser question: ${text}`
            ).catch(() => extractiveSearchAnswer(text, results))
          : extractiveSearchAnswer(text, results);
        answer = `${answer}\n\nFor the current picture, I searched just now:\n\n${fresh}`;
      }
    }
  } else if (wantsSearch || !SMALL_TALK.test(text)) {
    // Route 2: fresh search question. (Anything that is not clearly
    // small talk and not a memory question is treated as information
    // seeking: searching when unsure beats confidently guessing.)
    route = "search";
    const results = dedupeSources(await doSearch(text));
    sources = results;
    if (!results.length) {
      answer =
        "I tried searching the web just now but got no usable results (the search provider may be rate limiting). Please try again in a moment, or add a Tavily or Brave key in .env for more reliable search.";
    } else if (config.openaiApiKey) {
      try {
        answer = await callLlm(
          SYSTEM_PROMPT,
          `Today is ${today}.\n\nSearch results:\n${formatResultsForPrompt(results)}\n\nUser question: ${text}\n\nAnswer using the search results, with inline citations and dates where known.`
        );
      } catch {
        answer = extractiveSearchAnswer(text, results);
      }
    } else {
      answer = extractiveSearchAnswer(text, results);
    }
  } else {
    // Route 4: plain chat.
    route = "chat";
    if (config.openaiApiKey) {
      answer = await callLlm(
        SYSTEM_PROMPT,
        `Today is ${today}. Reply briefly and warmly to this small talk, and if natural, remind the user they can ask you current questions (you can search the web) or ask what you discussed on a past day.\n\nUser: ${text}`
      ).catch(
        () =>
          "Hello. Ask me anything current and I will search the web for it, or ask me what we discussed on a past day and I will check my memory of this conversation."
      );
    } else {
      answer =
        "Hello. Ask me anything current and I will search the web for it, or ask me what we discussed on a past day and I will check my memory of this conversation.";
    }
  }

  // Every turn is persisted with its fact snapshot, whichever route ran.
  // That is what makes tomorrow's "has it changed?" questions answerable.
  const snapshot = buildSnapshot(text, answer, sources);
  const turn = await addTurn(conversationId, {
    question: text,
    answer,
    sources,
    snapshot,
  });

  return {
    answer,
    sources,
    route,
    conversationId,
    turnId: turn.id,
    timestamp: turn.timestamp,
    matchedTurns: matched.map((t) => ({
      id: t.id,
      dateLocal: t.dateLocal,
      question: t.question,
    })),
  };
}
