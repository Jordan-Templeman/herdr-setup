// A Claude Code transcript (one JSON record per line) as chat messages:
//   { role: "user", text, images, command?, queued? }   images: cache names ("<uuid>-<n>.<ext>"), see imagesScript
//   { role: "output", text }
//   { role: "relay", from, summary, text }   a message from another session   what a slash command printed
//   { role: "assistant", parts: [{ kind: "text", text } | { kind: "tool", id, name, summary, status }] }
// Sub-agent (sidechain) and meta records are left out, and so is text Claude Code injects
// into user turns (command echoes, system reminders), which starts with a tag.

// Injected text is a whole message wrapped in one tag, like <system-reminder>…</system-reminder>.
const INJECTED = /^\s*<([a-z][\w-]*)[\s>][\s\S]*<\/\1>\s*$|^\s*<(command-|local-command|system-reminder)/;

// One line about a tool call: the thing it acts on.
export function summary(name, input = {}) {
  const v = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.prompt;
  const text = typeof v === "string" ? v : "";
  const short = text.replace(/\s+/g, " ").trim();
  return short.length > 90 ? `${short.slice(0, 87)}…` : short;
}

const resultText = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("\n") : "";

// A slash command as typed: "/name args".
function command(text) {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

const stdout = (text) => (/<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(text)?.[1] ?? "")
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();

// A message relayed from another session (a teammate, a helper agent): one entry per sender, with
// its one-line summary, so the chat can fold them.
const RELAY = /^\s*Another Claude session sent a message:/;
function relays(text) {
  if (!RELAY.test(text)) return null;
  const rest = text.replace(RELAY, "").trim();
  const out = [...rest.matchAll(/<teammate-message([^>]*)>([\s\S]*?)<\/teammate-message>/g)].map(([, attrs, body]) =>
    relay(/teammate_id="([^"]*)"/.exec(attrs)?.[1], /summary="([^"]*)"/.exec(attrs)?.[1], body.trim()));
  return out.length ? out : [relay(null, null, rest)];
}

// A status ping (JSON like {"type":"idle_notification","result":…}) reads as its state plus the
// first line of any result; anything else keeps its summary or first line.
function relay(from, summary, body) {
  try {
    const j = JSON.parse(body);
    const state = j.type === "idle_notification" ? (j.idleReason === "available" ? "idle" : j.idleReason ?? "idle") : (j.type ?? "").replace(/_/g, " ");
    const result = String(j.result ?? j.message ?? "").trim();
    const first = result.split("\n")[0].replace(/[*#`]/g, "").trim();
    return { role: "relay", from: from ?? j.from ?? "session", summary: [state, first].filter(Boolean).join(" · "), text: result || state };
  } catch {
    return { role: "relay", from: from ?? "session", summary: summary || body.split("\n")[0].slice(0, 140), text: body };
  }
}

export function parse(text) {
  const messages = [];
  const tools = new Map();
  const assistant = () => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") return last;
    const fresh = { role: "assistant", parts: [] };
    messages.push(fresh);
    return fresh;
  };

  // Messages sent while Claude was busy, until it takes them.
  const queued = [];

  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "queue-operation") {
      if (r.operation === "enqueue") queued.push(r.content ?? "");
      else queued.shift();
      continue;
    }
    if (r.isSidechain) continue;
    // A command Claude Code runs itself (/context, /model): what was typed, then what it printed.
    if (r.type === "system" && r.subtype === "local_command") {
      const typed = command(r.content ?? "");
      const out = stdout(r.content ?? "");
      if (typed) messages.push({ role: "user", text: typed, images: [], command: true });
      else if (out) messages.push({ role: "output", text: out });
      continue;
    }
    // Some commands also leave a tidier, markdown copy of their output.
    if (r.isMeta && r.type === "user" && messages[messages.length - 1]?.role === "output") {
      const c = r.message?.content;
      const md = typeof c === "string" ? c : (c ?? []).map((b) => b.text ?? "").join("\n");
      if (md.trim()) messages[messages.length - 1].text = md.trim();
      continue;
    }
    if (r.isMeta || (r.type !== "user" && r.type !== "assistant")) continue;
    const content = r.message?.content;

    if (r.type === "user") {
      // A skill or custom command: the command as typed (its expansion is a meta record).
      const flat = typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n");
      const typed = command(flat);
      if (typed) {
        messages.push({ role: "user", text: typed, images: [], command: true });
        const out = stdout(flat);
        if (out) messages.push({ role: "output", text: out });
        continue;
      }
      if (typeof content === "string") {
        const relayed = relays(content);
        if (relayed) messages.push(...relayed);
        else if (content.trim() && !INJECTED.test(content)) messages.push({ role: "user", text: content.trim(), images: [] });
        continue;
      }
      let said = "";
      const images = [];
      for (const block of content ?? []) {
        if (block.type === "text" && !INJECTED.test(block.text ?? "")) said += (said ? "\n\n" : "") + block.text.trim();
        else if (block.type === "image") images.push(`${r.uuid}-${images.length}.${(block.source?.media_type ?? "image/png").split("/")[1]}`);
        else if (block.type === "tool_result") {
          const tool = tools.get(block.tool_use_id);
          if (tool) {
            tool.status = block.is_error ? "error" : "done";
            if (block.is_error) tool.error = resultText(block.content).trim().split("\n")[0].slice(0, 160);
          }
        }
      }
      const relayed = relays(said);
      if (relayed) messages.push(...relayed);
      else if (said || images.length) messages.push({ role: "user", text: said, images });
      continue;
    }

    for (const block of content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        const parts = assistant().parts;
        const last = parts[parts.length - 1];
        if (last?.kind === "text") last.text += `\n\n${block.text.trim()}`;
        else parts.push({ kind: "text", text: block.text.trim() });
      } else if (block.type === "tool_use") {
        const tool = { kind: "tool", id: block.id, name: block.name, summary: summary(block.name, block.input), status: "running" };
        tools.set(block.id, tool);
        assistant().parts.push(tool);
      }
    }
  }
  for (const q of queued) if (q.trim()) messages.push({ role: "user", text: q.trim(), images: [], queued: true });
  return messages;
}

// Where Claude Code keeps a session's transcript: its folder with every character that isn't a
// letter or digit turned into "-".
export function transcriptPath(home, cwd, sessionId) {
  return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${sessionId}.jsonl`;
}

// The session record carries the id without dashes (record values cap at 32 characters).
export const dashed = (id) =>
  id.length === 32 ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : id;

// Writes a transcript's pasted images (kept inline as base64) to files image() can show,
// named as parse names them. Args: transcript path, cache folder.
export const imagesScript = `
import json, sys, os, base64
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for line in open(src):
    if '"image"' not in line: continue
    try: r = json.loads(line)
    except Exception: continue
    c = (r.get("message") or {}).get("content")
    if r.get("type") != "user" or not isinstance(c, list): continue
    n = 0
    for b in c:
        if b.get("type") != "image": continue
        s = b.get("source") or {}
        name = "%s-%d.%s" % (r.get("uuid"), n, (s.get("media_type") or "image/png").split("/")[1])
        n += 1
        f = os.path.join(out, name)
        if s.get("data") and not os.path.exists(f):
            open(f, "wb").write(base64.b64decode(s["data"]))
`;

// Claude Code's selection UI on a terminal screen (permission prompts, /model, folder trust):
// the context above it, the question, and each option with the keys that pick it. Null when the
// screen shows none. Options are "❯ 1. Yes" / "  2. No" lines, numbered or not, one marked ❯,
// with key hints ("Esc to cancel") under them.
const RULE = /^\s*[─━═▔]{8,}/;
const FOOTER = /^\s*(Esc to|Enter to|Tab to|\(esc\))/i;
export function screenPrompt(screen) {
  const lines = screen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (/^\s*❯\s/.test(lines[i]) && !RULE.test(lines[i + 1] ?? "")) at = i;
  if (at < 0) return null;
  const pad = lines[at].indexOf("❯");
  const numbered = /^\s*❯\s*\d+\.\s/.test(lines[at]);
  // An option line: the ❯ column (or a scroll arrow), then (when numbered) "N. ".
  const option = (l) => {
    if (l.length <= pad || /\S/.test(l.slice(0, pad))) return null;
    const m = /^([❯↑↓]|\s)\s*(?:(\d+)\.\s+)?(\S.*)$/.exec(l.slice(pad));
    if (!m || (numbered && !m[2])) return null;
    const [label, ...about] = m[3].replace(/\s*✔/g, "").trim().split(/\s{2,}/);
    return { selected: m[1] === "❯", n: m[2] ? Number(m[2]) : null, label, about: about.join(" ") || undefined };
  };
  // A numbered option's wrapped description, indented past the number.
  const more = (l) => numbered && Boolean(l.trim()) && !FOOTER.test(l) && !option(l) && l.length - l.trimStart().length > pad + 3;
  let start = at;
  while (start > 0 && (option(lines[start - 1]) || more(lines[start - 1]))) start--;
  while (!option(lines[start])) start++;
  const options = [];
  let end = start;
  for (; end < lines.length; end++) {
    const o = option(lines[end]);
    if (o) options.push(o);
    else if (more(lines[end])) {
      const last = options[options.length - 1];
      last.about = [last.about, lines[end].trim()].filter(Boolean).join(" ");
    } else break;
  }
  // Its key hints just below tell a real list from a typed "❯" line in the scrollback.
  const footer = lines.slice(end, end + 8).find((l) => FOOTER.test(l));
  if (options.length < 2 || !footer) return null;
  const sel = options.findIndex((o) => o.selected);
  options.forEach((o, k) => { o.keys = [...Array(Math.abs(k - sel)).fill(k > sel ? "down" : "up"), "enter"]; });
  // Above the list, back to the prompt's rule line: the question and what the prompt shows.
  const above = [];
  for (let i = start - 1; i >= 0 && !RULE.test(lines[i]) && above.length < 12; i--) above.unshift(lines[i]);
  const text = above.filter((l) => l.trim() && !/^\s*[╌─]+\s*$/.test(l) && !/^\s*Tip:/.test(l)).map((l) => l.trim());
  // The line asking something, else the prompt's title (its first line).
  let q = text.length - 1;
  while (q >= 0 && !text[q].includes("?")) q--;
  const question = text.splice(Math.max(q, 0), 1)[0] ?? "Claude is asking";
  return { question, context: text.slice(-6), options, footer: footer.trim() };
}
