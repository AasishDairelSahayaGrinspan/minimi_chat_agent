// Chat UI logic. Deliberately small: render history, send one POST per
// message, render the answer with its sources and route.
//
// Conversation id: the first visit uses the shared "demo" conversation,
// which is the one `npm run seed` fills with backdated demo turns, so a
// reviewer can test temporal questions immediately. "New chat" starts a
// fresh, private conversation id.
const messagesEl = document.getElementById("messages");
const form = document.getElementById("chatForm");
const input = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");

let conversationId = localStorage.getItem("minimi-conversation-id");
if (!conversationId) {
  conversationId = "demo";
  localStorage.setItem("minimi-conversation-id", conversationId);
}

function addMessage(role, text, extra = {}) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  if (extra.route) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `route: ${extra.route}${extra.when ? ` - ${extra.when}` : ""}`;
    div.appendChild(meta);
  }
  if (extra.sources && extra.sources.length) {
    const box = document.createElement("div");
    box.className = "sources";
    const label = document.createElement("div");
    label.textContent = "Sources:";
    box.appendChild(label);
    extra.sources.forEach((s, i) => {
      const a = document.createElement("a");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `[${i + 1}] ${s.title}${s.publishedDate ? ` (${s.publishedDate})` : ""}`;
      box.appendChild(a);
    });
    div.appendChild(box);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function loadHistory() {
  try {
    const res = await fetch(`/api/history?conversationId=${encodeURIComponent(conversationId)}`);
    const data = await res.json();
    for (const turn of data.turns || []) {
      addMessage("user", turn.question);
      addMessage("agent", turn.answer, {
        sources: turn.sources,
        when: new Date(turn.timestamp).toLocaleDateString(),
      });
    }
    if (!data.turns || !data.turns.length) {
      addMessage(
        "agent",
        "Hello. Ask me anything current and I will search the web. Or, if you ran npm run seed, ask me what you asked about Postgres hosting last Tuesday and whether pricing has changed."
      );
    }
  } catch {
    addMessage("agent", "Could not load history. Is the server running?");
  }
}

async function sendMessage(text) {
  addMessage("user", text);
  const pending = addMessage("agent", "Thinking (and searching, if needed)...");
  pending.classList.add("pending");
  sendBtn.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversationId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    pending.remove();
    addMessage("agent", data.answer, { sources: data.sources, route: data.route });
  } catch (err) {
    pending.remove();
    addMessage("agent", `Something went wrong: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendMessage(text);
});

document.querySelectorAll(".hint").forEach((btn) => {
  btn.addEventListener("click", () => sendMessage(btn.textContent.trim()));
});

document.getElementById("newChatBtn").addEventListener("click", () => {
  conversationId = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem("minimi-conversation-id", conversationId);
  messagesEl.innerHTML = "";
  addMessage("agent", "New chat started. My memory is per conversation, so this chat starts with a clean history.");
});

loadHistory();
input.focus();
