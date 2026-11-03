// A Codex rollout (~/.codex/sessions/**/rollout-*.jsonl) as the chat messages transcript.js makes.
// Its "item_completed" events are what the Codex UI shows: user and agent messages, commands,
// file changes, MCP and web calls. The array's `working` is true while a turn is unfinished.
import { summary } from "./transcript.js";

export const isCodex = (path) => /(^|\/)rollout-[^/]*\.jsonl$/.test(path);

const base = (p) => p.replace(/^file:\/\//, "").split("/").pop();
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 160);
const status = (s) => (s === "failed" ? "error" : s === "completed" || !s ? "done" : "running");

// One tool chip for a completed item, or null for items the chat doesn't show.
function tool(it) {
  const t = { kind: "tool", id: it.id, status: status(it.status) };
  switch (it.type) {
    case "CommandExecution": {
      const cmd = it.parsed_cmd?.[0]?.cmd ?? (Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command);
      if (t.status === "error") t.error = firstLine(it.stderr) || `exit ${it.exit_code}`;
      return { ...t, name: "Shell", summary: summary("Shell", { command: cmd }) };
    }
    case "McpToolCall":
      return { ...t, name: `${it.server}.${it.tool}`, summary: summary(it.tool, it.arguments ?? {}) };
    case "FileChange":
      return { ...t, name: "Edit", summary: Object.keys(it.changes ?? {}).map(base).join(", ") };
    case "Extension":
      return { ...t, name: it.kind ?? "Extension", summary: summary("", { query: it.query ?? it.revisedPrompt ?? "" }) };
    case "ImageView":
      return { ...t, name: "View image", summary: base(it.path ?? "") };
    case "CollabAgentToolCall":
      return { ...t, name: `Agent ${it.tool}`, summary: (it.receiver_agents ?? []).map((a) => a.agent_path ?? a).join(", ") };
    case "SubAgentActivity":
      return { ...t, name: "Sub-agent", summary: `${it.agent_path ?? ""} ${it.kind ?? ""}`.trim() };
    default:
      return null;
  }
}

export function parseCodex(text) {
  const messages = [];
  let open = false;
  const assistant = () => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") return last;
    const fresh = { role: "assistant", parts: [] };
    messages.push(fresh);
    return fresh;
  };
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const p = r.payload ?? {};
    if (r.type !== "event_msg") continue;
    if (p.type === "task_started") open = true;
    else if (p.type === "task_complete" || p.type === "turn_aborted") open = false;
    if (p.type !== "item_completed" || !p.item) continue;
    const it = p.item;
    if (it.type === "UserMessage") {
      const said = (it.content ?? []).map((c) => c.text ?? c.path ?? c.image_url ?? "").filter(Boolean).join("\n\n").trim();
      if (said) messages.push({ role: "user", text: said, images: [] });
    } else if (it.type === "AgentMessage") {
      const said = (it.content ?? []).map((c) => c.text ?? "").join("\n\n").trim();
      if (!said) continue;
      const parts = assistant().parts;
      const last = parts[parts.length - 1];
      if (last?.kind === "text") last.text += `\n\n${said}`;
      else parts.push({ kind: "text", text: said });
    } else if (it.type === "ContextCompaction") {
      messages.push({ role: "output", text: "Context compacted" });
    } else {
      const t = tool(it);
      if (t) assistant().parts.push(t);
    }
  }
  messages.working = open;
  return messages;
}
