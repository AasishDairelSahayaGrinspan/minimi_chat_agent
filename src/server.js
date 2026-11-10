// HTTP server: a static chat page plus two JSON endpoints.
//
//   GET  /                -> the chat UI (public/)
//   GET  /api/history     -> turns of one conversation
//                            (?conversationId=..., defaults to "demo")
//   POST /api/chat        -> { message, conversationId? }
//                            returns { answer, sources, route, ... }
//
// Plain node:http on purpose: the surface is tiny, and with zero
// dependencies there is nothing to install and nothing to break.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { loadMemory, getTurns } from "./memory.js";
import { handleMessage } from "./agent.js";
import { activeProviderName } from "./search.js";

const publicDir = join(config.root, "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(req, res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // Normalise and refuse anything that escapes the public folder.
  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(req);
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { error: "message is required" });
      const conversationId = String(body.conversationId || "").trim() || `conv-${randomUUID()}`;
      const result = await handleMessage(conversationId, message);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/api/history") {
      const conversationId = url.searchParams.get("conversationId") || "demo";
      return sendJson(res, 200, {
        conversationId,
        turns: getTurns(conversationId),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        searchProvider: activeProviderName(),
        llm: config.openaiApiKey ? config.openaiModel : "off (extractive mode)",
      });
    }

    if (req.method === "GET") return serveStatic(req, res, url.pathname);

    return sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: "Something went wrong handling that message." });
  }
});

await loadMemory();
server.listen(config.port, () => {
  console.log(`minimi-chat-agent listening on http://localhost:${config.port}`);
  console.log(`search provider: ${activeProviderName()}, llm: ${config.openaiApiKey ? config.openaiModel : "off (extractive mode)"}`);
});
