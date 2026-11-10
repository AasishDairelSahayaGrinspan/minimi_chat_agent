// Fact snapshot extraction.
//
// The whole memory idea rests on this file: when the agent answers a
// question, we do not only store the prose. We also store a small,
// machine-comparable snapshot of the concrete facts in that answer:
// money amounts, version numbers, percentages and the top source titles.
// Weeks later, "has pricing changed since then?" becomes a set
// comparison between the old snapshot and facts extracted from a fresh
// search, instead of a fuzzy "the model feels it changed".

const MONEY_RE =
  /(?:\$|€|£|Rs\.?|INR|USD)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:\/|per)\s?(?:month|mo|user|seat|year|yr))?/gi;
const VERSION_RE = /\b(?:v|version\s?)\d+(?:\.\d+){1,2}\b|\b\d+\.\d+\.\d+\b/gi;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s?%/g;
// Product or release style tokens, for example "Postgres 16" or "GPT-5".
const NAMED_VERSION_RE = /\b[A-Z][A-Za-z]{2,}\s\d{1,2}\b/g;
// Month names also match that shape ("Nov 5") and are dates, not versions.
// Listicle words also match that shape ("Top 7", "Ranked 4") and are
// not versions either.
const GENERIC_WORDS = new Set([
  "top", "best", "ranked", "ranking", "ways", "tips", "steps", "reasons",
  "tools", "apps", "providers", "options", "examples", "questions",
  "alternatives", "sites", "services", "companies", "plugins",
  "for", "compare", "compared", "including", "with", "from",
]);
const MONTH_WORDS = new Set([
  "jan", "january", "feb", "february", "mar", "march", "apr", "april",
  "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept",
  "september", "oct", "october", "nov", "november", "dec", "december",
]);

const STOPWORDS = new Set(
  ("a an the is are was were what did do does has have had any of for to in on at " +
    "and or since then than it its this that with without about ask asked you i me my " +
    "we our they them he she when who how why which been be can could should would " +
    "last monday tuesday wednesday thursday friday saturday sunday week month year " +
    "today yesterday tomorrow change changed changes still correct right now please tell")
    .split(" ")
);

function unique(values, limit = 12) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].slice(0, limit);
}

// Extract the comparable facts out of any text (an answer, or the
// snippets of a fresh search result set).
export function extractFacts(text) {
  const t = String(text || "");
  return {
    money: unique(t.match(MONEY_RE) || []),
    versions: unique([
      ...(t.match(VERSION_RE) || []),
      ...(t.match(NAMED_VERSION_RE) || []).filter((v) => {
        const word = v.split(/\s+/)[0].toLowerCase();
        return !MONTH_WORDS.has(word) && !GENERIC_WORDS.has(word);
      }),
    ]),
    percents: unique(t.match(PERCENT_RE) || []),
  };
}

// Keywords used for topic retrieval: content words of a question with
// stopwords and temporal words removed, so "what did I ask about
// Postgres hosting last Tuesday" reduces to ["postgres", "hosting"].
export function extractKeywords(text) {
  return unique(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    10
  );
}

// Build the snapshot stored with every turn.
export function buildSnapshot(question, answer, sources) {
  const facts = extractFacts(`${question}\n${answer}`);
  return {
    money: facts.money,
    versions: facts.versions,
    percents: facts.percents,
    keywords: extractKeywords(`${question} ${answer.slice(0, 400)}`),
    sourceTitles: (sources || []).slice(0, 3).map((s) => s.title),
  };
}

// Compare an old snapshot against facts from a fresh search.
// Honesty rule: a fact is "changed" only when the fresh results contain
// new values for the same kind of fact; a fact is "unchanged" only when
// the exact value reappears. Everything else is "unconfirmed", never
// silently treated as unchanged.
export function compareFacts(oldSnapshot, freshText) {
  const fresh = extractFacts(freshText);
  const result = { changed: [], unchanged: [], unconfirmed: [] };

  const compareKind = (label, oldValues, freshValues) => {
    for (const value of oldValues) {
      if (freshValues.some((f) => f.toLowerCase() === value.toLowerCase())) {
        result.unchanged.push(`${label}: ${value}`);
      } else {
        result.unconfirmed.push(`${label}: ${value}`);
      }
    }
    for (const value of freshValues) {
      if (!oldValues.some((o) => o.toLowerCase() === value.toLowerCase())) {
        result.changed.push(`${label}: ${value} (new in fresh results)`);
      }
    }
  };

  compareKind("price", oldSnapshot.money || [], fresh.money);
  compareKind("version", oldSnapshot.versions || [], fresh.versions);
  compareKind("figure", oldSnapshot.percents || [], fresh.percents);
  return result;
}
