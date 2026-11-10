# minimi chat agent

A chat agent with exactly one tool: web search. What makes it different
is its memory. Every answer is stored with a timestamp and a small
snapshot of the concrete facts in it (prices, versions, figures), so
days later you can ask "has that changed since I asked?" and get a real
comparison between what you were told then and what the web says now,
instead of a fresh answer that ignores the past.

## Run it

```bash
npm install   # zero dependencies, so this is near instant
npm run dev   # starts on http://localhost:3000
```

Open http://localhost:3000 and chat. It works with no API keys at all:
search falls back to a keyless DuckDuckGo provider and answers are
composed extractively from the search results, clearly labelled as such.

Optional keys live in `.env` (copy `.env.example`). An `OPENAI_API_KEY`
upgrades answers to fluent LLM-written ones. A `TAVILY_API_KEY` or
`BRAVE_API_KEY` upgrades search quality and gives results real
publication dates. See `.env.example` for the full list.

## Try the questions it was built for

First, seed a past:

```bash
npm run seed
```

This writes three honestly backdated demo conversations (dates computed
relative to today): a Postgres hosting question from last Tuesday, a
CRM shortlist from last Monday, and a Notion pricing question from
3 November. Then, in the chat, ask:

1. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
2. "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
3. "What did I ask you on 3 November? Is your answer still correct today?"

You can also ask fresh questions ("What is the current pricing of
Supabase?") and plain small talk. Every new conversation you have adds
to the memory those questions draw on.

## How it works

Each message takes one of four routes, decided in plain code in
`src/agent.js`:

- **memory**: questions about the past ("what did I ask on 3 November")
  are answered from stored turns only.
- **search**: fresh questions get one web search and an answer with
  inline citations like [1], [2] and source dates when known.
- **compare**: "has it changed" questions retrieve the old turn, run a
  fresh search, and diff the stored fact snapshot against the new
  results, listing what changed, what is unchanged, and what could not
  be confirmed.
- **chat**: small talk needs no tool.

Memory retrieval (`src/memory.js`, `src/dates.js`) resolves explicit
dates ("3 November"), relative dates ("last Tuesday", "on Monday") and
topic keywords, in that order. Turns are persisted to
`data/conversations.json` with atomic writes, per conversation id.

Search (`src/search.js`) hides three providers behind one interface:
Tavily, Brave, and a keyless DuckDuckGo HTML fallback, all returning
`{ title, url, snippet, publishedDate }`. Results are cached for 10
minutes and a question costs at most 2 search calls.

## Project layout

```
src/server.js    HTTP server, static UI, POST /api/chat, GET /api/history
src/agent.js     routing (memory / search / compare / chat), answer composition
src/memory.js    JSON persistence and retrieval by date, then by topic
src/dates.js     "3 November", "last Tuesday" and friends, resolved to real dates
src/extract.js   fact snapshot extraction and snapshot comparison
src/search.js    the one tool: Tavily / Brave / DuckDuckGo behind one interface
src/config.js    env loading (a tiny built-in .env reader, no packages)
public/          the chat page (index.html, style.css, app.js)
scripts/seed-demo.js   backdated demo turns for instant temporal testing
data/            conversations.json is created here at runtime
```

## Design notes

The reasoning behind the architecture, what was considered and
rejected, and what another week would add, is in [DESIGN.md](DESIGN.md).
