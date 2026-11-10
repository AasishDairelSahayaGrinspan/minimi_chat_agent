// Conversation memory, persisted as one JSON file.
//
// Why a JSON file and not a database: a single-user chat history is
// small, and a file the reviewer can open and read is worth more than
// infrastructure. Writes are atomic (write a temp file, then rename),
// so a crash mid-write can never corrupt the history.
//
// Layout of data/conversations.json:
//   { "conversations": { "<id>": { "id", "createdAt", "turns": [...] } } }
// Each turn: { id, timestamp, dateLocal, question, answer, sources,
//              snapshot }  (see extract.js for the snapshot shape)

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { toDateLocal, monthDayLocal, resolveReferencedDate } from "./dates.js";
import { extractKeywords } from "./extract.js";

const dataDir = join(config.root, "data");
const dataFile = join(dataDir, "conversations.json");

let store = { conversations: {} };
let loaded = false;
// Serialise writes so two near-simultaneous turns cannot race the file.
let writeChain = Promise.resolve();

export async function loadMemory() {
  await mkdir(dataDir, { recursive: true });
  if (existsSync(dataFile)) {
    try {
      store = JSON.parse(await readFile(dataFile, "utf8"));
      if (!store.conversations) store = { conversations: {} };
    } catch {
      // A corrupt file should not kill the agent; start clean but keep
      // serving. The bad file is left on disk for inspection.
      store = { conversations: {} };
    }
  }
  loaded = true;
  return store;
}

async function persist() {
  const tmp = `${dataFile}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2));
  await rename(tmp, dataFile);
}

export function getConversation(conversationId) {
  if (!store.conversations[conversationId]) {
    store.conversations[conversationId] = {
      id: conversationId,
      createdAt: new Date().toISOString(),
      turns: [],
    };
  }
  return store.conversations[conversationId];
}

export function getTurns(conversationId) {
  return store.conversations[conversationId]?.turns || [];
}

// Append one turn. `when` is injectable so the seed script can write
// honestly backdated demo turns through exactly the same code path.
export async function addTurn(conversationId, { question, answer, sources, snapshot }, when = new Date()) {
  if (!loaded) await loadMemory();
  const conversation = getConversation(conversationId);
  const turn = {
    id: randomUUID(),
    timestamp: when.toISOString(),
    dateLocal: toDateLocal(when),
    question,
    answer,
    sources: sources || [],
    snapshot,
  };
  conversation.turns.push(turn);
  writeChain = writeChain.then(persist).catch(() => {});
  await writeChain;
  return turn;
}

// Replace a conversation wholesale. Used only by the seed script.
export async function replaceConversation(conversationId, turns) {
  if (!loaded) await loadMemory();
  store.conversations[conversationId] = {
    id: conversationId,
    createdAt: new Date().toISOString(),
    turns,
  };
  writeChain = writeChain.then(persist).catch(() => {});
  await writeChain;
}

// Retrieval, in priority order:
//   1. explicit or relative date mentioned in the question
//   2. topic keyword overlap with the stored question, answer and
//      snapshot keywords
// Returns { turns, byDate, reference } where reference describes the
// date that was resolved, if any.
export function findRelevantTurns(conversationId, query, limit = 3) {
  const turns = getTurns(conversationId);
  if (!turns.length) return { turns: [], byDate: false, reference: null };

  const reference = resolveReferencedDate(query);
  if (reference) {
    const byFullDate = turns.filter((t) => t.dateLocal === reference.dateLocal);
    // Explicit dates ("3 November") also match on month and day alone,
    // so a turn from last November is still found this November.
    const byMonthDay = reference.monthDay
      ? turns.filter((t) => monthDayLocal(t.dateLocal) === reference.monthDay)
      : [];
    const matched = byFullDate.length ? byFullDate : byMonthDay;
    if (matched.length) {
      // A date can hold several turns ("what did I ask on 3 November"
      // wants all of them), but a dated question with a topic ("Postgres
      // hosting last Tuesday") wants the on-topic turns of that day.
      // Rank by topic overlap; if any turn scores, drop the zero-score
      // ones. Pure date questions score zero everywhere and keep all.
      const keywords = extractKeywords(query);
      const scored = matched.map((turn) => {
        const haystack = `${turn.question} ${turn.answer.slice(0, 300)} ${(turn.snapshot?.keywords || []).join(" ")}`.toLowerCase();
        const score = keywords.reduce((sum, kw) => sum + (haystack.includes(kw) ? 1 : 0), 0);
        return { turn, score };
      });
      const anyScored = scored.some((s) => s.score > 0);
      const kept = (anyScored ? scored.filter((s) => s.score > 0) : scored)
        .sort((a, b) => b.score - a.score || a.turn.timestamp.localeCompare(b.turn.timestamp))
        .map((s) => s.turn);
      return { turns: kept.slice(0, limit), byDate: true, reference };
    }
    // A date was named but nothing happened that day. Fall through to
    // topic search, but keep the reference so the agent can say
    // honestly "I have nothing from that day, closest match is...".
    const topic = topicSearch(turns, query, limit);
    return { turns: topic, byDate: false, reference };
  }

  return { turns: topicSearch(turns, query, limit), byDate: false, reference: null };
}

function topicSearch(turns, query, limit) {
  const keywords = extractKeywords(query);
  if (!keywords.length) return [];
  const scored = turns
    .map((turn) => {
      const haystack = [
        turn.question,
        turn.answer.slice(0, 500),
        ...(turn.snapshot?.keywords || []),
        ...(turn.snapshot?.sourceTitles || []),
      ]
        .join(" ")
        .toLowerCase();
      const score = keywords.reduce(
        (sum, kw) => sum + (haystack.includes(kw) ? 1 : 0),
        0
      );
      return { turn, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.turn.timestamp.localeCompare(a.turn.timestamp));
  return scored.slice(0, limit).map((s) => s.turn);
}
