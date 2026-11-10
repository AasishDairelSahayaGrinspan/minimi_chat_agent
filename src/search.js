// The one tool: web search, behind a small provider interface.
//
// Every provider returns the same shape:
//   [{ title, url, snippet, publishedDate }]   (publishedDate may be null)
// The agent never knows or cares which provider answered.
//
// Provider order: Tavily (best dates) -> Brave -> DuckDuckGo HTML
// (keyless, so the agent works with zero API keys). Set a key in .env
// to upgrade; set none and it still works.

import { config } from "./config.js";

const MAX_RESULTS = 6;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // normalizedQuery -> { at, results }

function normalizeQuery(query) {
  return String(query || "").toLowerCase().trim().replace(/\s+/g, " ");
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Tavily -------------------------------------------------------------
async function searchTavily(query) {
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: MAX_RESULTS,
      search_depth: "basic",
    }),
  });
  if (!res.ok) throw new Error(`Tavily search failed with HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.content || "",
    publishedDate: r.published_date || null,
  }));
}

// --- Brave --------------------------------------------------------------
async function searchBrave(query) {
  const url =
    "https://api.search.brave.com/res/v1/web/search?q=" +
    encodeURIComponent(query) +
    `&count=${MAX_RESULTS}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": config.braveApiKey,
    },
  });
  if (!res.ok) throw new Error(`Brave search failed with HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.description || "",
    publishedDate: r.page_age || null,
  }));
}

// --- DuckDuckGo (keyless fallback) ---------------------------------------
// Parses the plain HTML results page. Exported separately so the parser
// can be unit-checked without any network access.
export function parseDuckDuckGoHtml(html) {
  const results = [];
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<td[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/td>)/g;
  const strip = (s) =>
    String(s || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  let match;
  while ((match = blockRe.exec(html)) && results.length < MAX_RESULTS) {
    let url = match[1];
    // DuckDuckGo wraps result URLs: //duckduckgo.com/l/?uddg=<encoded>
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        // keep the raw URL if decoding fails
      }
    }
    if (url.startsWith("//")) url = `https:${url}`;
    const title = strip(match[2]);
    const snippet = strip(match[3] || match[4] || "");
    if (title && url.startsWith("http")) results.push({ title, url, snippet, publishedDate: null });
  }
  return results;
}

async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      // A plain browser-style user agent; the HTML endpoint refuses
      // obvious bots more often than browsers.
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed with HTTP ${res.status}`);
  const html = await res.text();
  const results = parseDuckDuckGoHtml(html);
  if (!results.length) {
    throw new Error("DuckDuckGo returned no parseable results (possible bot check)");
  }
  return results;
}

// --- Public entry point ---------------------------------------------------
// Cached for 10 minutes per normalized query: temporal questions often
// re-ask the same thing, and search APIs are the slow, rate-limited
// part of the system.
export async function searchWeb(query) {
  const key = normalizeQuery(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

  const providers = [];
  if (config.tavilyApiKey) providers.push(searchTavily);
  if (config.braveApiKey) providers.push(searchBrave);
  providers.push(searchDuckDuckGo);

  const errors = [];
  for (const provider of providers) {
    try {
      const results = await provider(query);
      if (results.length) {
        cache.set(key, { at: Date.now(), results });
        return results;
      }
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(`All search providers failed: ${errors.join("; ")}`);
}

export function activeProviderName() {
  if (config.tavilyApiKey) return "tavily";
  if (config.braveApiKey) return "brave";
  return "duckduckgo";
}
