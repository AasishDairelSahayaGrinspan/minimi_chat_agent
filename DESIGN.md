# Design

## The problem

Most chat agents with web search are stateless answer machines. Ask one
about Postgres hosting on Tuesday and again on Friday, and Friday's
answer knows nothing about Tuesday's. But the questions real users ask
are temporal: "has pricing changed since I asked?", "is what you told
me on 3 November still correct?" Answering those well needs more than
search. It needs a memory of what was claimed, when, and a way to check
those claims against the world as it is now. That is the problem this
agent is built around.

## How it works

Every message is routed in plain code (`src/agent.js`) into one of four
paths: memory only, fresh search, memory plus fresh search comparison,
or plain chat.

Memory is the core design choice. Every turn is persisted to a JSON
file with its timestamp, the question, the answer, the sources used,
and a fact snapshot extracted from the answer: money amounts, version
numbers, percentages, keywords and top source titles (`src/extract.js`).
A comparison question then becomes a concrete operation. Retrieve the
old turn, run a fresh search, extract facts from the new results, and
diff the two sets. The answer separates "changed", "unchanged" and
"could not confirm", because a price missing from today's results is
not proof it changed, and the agent should never pretend otherwise.

Retrieval matches how people name time. Explicit dates ("3 November"),
relative dates ("last Tuesday", "on Monday") and topic keywords are
tried in that order (`src/dates.js`, `src/memory.js`). Dates resolve
against the stored local date of each turn, so "what did I ask on
3 November" is an exact match, not a similarity guess.

The single tool, web search, sits behind one interface with three
providers: Tavily, Brave, and a keyless DuckDuckGo fallback, so the
agent works with zero API keys and upgrades silently when keys exist.
Answers cite sources inline with dates when known. An LLM writes the
answers when a key is configured; without one, an extractive composer
answers directly from the top results and says so.
A ten-minute search cache and a hard budget of two searches per
question keep it fast and cheap.

## Why this way

Zero dependencies was a deliberate constraint. The server is
`node:http`, the store is a JSON file written atomically, and even the
`.env` loader is twenty lines. `npm install` cannot fail, there is no
framework between the reader and the logic, and a reviewer can read
every decision in the code.

## Considered and rejected

A vector database with embeddings for memory was the obvious candidate
and the wrong one here. A single user's chat history is small, and the
hard questions are exact ("what did I ask on 3 November"), where
embedding similarity is fuzzy and date arithmetic is precise. Keyword
plus date retrieval is faster, explainable and testable.

LangChain and similar frameworks were rejected because they hide
exactly the orchestration this exercise is about: when to search, what
to pass the model, how to compare. Hand-rolled routing is about two
hundred lines and can be defended line by line.

Streaming over sockets was rejected as ceremony. A simple request and
response is enough for a chat turn; nothing in the temporal or memory
behaviour depends on token streaming.

A real database was rejected for the same reason as the vector store:
for one user's history, a readable JSON file is a feature, not a
shortcut.

## With another week

First, server-sent events for streaming answers, since the routing
already separates composition from transport. Second, embeddings as a
second retrieval signal alongside dates and keywords, useful once
histories grow past a few hundred turns and topic wording drifts.
Third, per-user memories with proper identity, instead of per
conversation ids. Fourth, an evaluation harness of scripted temporal
questions with known past answers and planted changes, so "did it
notice the price move?" becomes a measured score rather than an
impression. Finally, richer snapshots: extracting facts per entity
rather than per turn, so a five-product shortlist compares product by
product instead of as one bag of prices.
