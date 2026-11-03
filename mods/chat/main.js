// A Claude session as a chat: your messages and Claude's replies as bubbles, its tool calls
// folded into "N steps" chips, and a message box that types into the live session. It reads
// the session's transcript (found from the hook's "session" record) and follows it as it grows.
// Opens beside a terminal (props.terminal) or as a window for the focused one (⌘⇧K).
// Typing "/" suggests slash commands: Claude Code's own, and the skills in ~/.claude and the project.
// A question or permission prompt on the terminal's screen shows as buttons that answer it.
// Read-only with props { transcript: "<absolute .jsonl>", title? }: a Claude Code transcript or a
// Codex rollout for a session running outside Herdr, followed as it grows, without a composer.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, hc, home, appHome, terminals, agents, focused, props, run, theme, closeOverlay, settings } from "herdr";
import { toCli, closeWith } from "./mode.js";
import { parse, transcriptPath, dashed, imagesScript, screenPrompt } from "./transcript.js";
import { parseCodex, isCodex } from "./codex.js";

const ICONS = "mods/workspace-chrome";
const TAIL = 1500000;
const SHOWN = 40;
const POLL_S = "1.5";

// Claude Code's own commands that print in the session (ones that open a picker still work, in the terminal).
const BUILTIN = [
  ["clear", "Start a new conversation"], ["compact", "Summarize the conversation to free up context"],
  ["context", "Show what's using the context window"], ["cost", "Show this session's cost and duration"],
  ["model", "Choose the model (opens a picker in the terminal)"], ["review", "Review a pull request"],
  ["resume", "Resume an earlier conversation (opens a picker in the terminal)"], ["status", "Show version, model and account"],
  ["memory", "Edit memory files"], ["help", "Show help"],
];

// Each skill's name and description, from its SKILL.md frontmatter.
const SKILLS_SH = `for d in "$HOME"/.claude/skills/*/ .claude/skills/*/; do f="$d"SKILL.md; [ -f "$f" ] && printf '%s\\t%s\\n' "$(basename "$d")" "$(sed -n 's/^description: *//p' "$f" | head -n1 | cut -c1-140)"; done; true`;

// Paths in a message that are images (pasted or dropped), and links.
const IMAGE_PATH = /(?:"([^"]+\.(?:png|jpe?g|gif|webp))"|((?:~|\/)[^\s"]+\.(?:png|jpe?g|gif|webp)))/gi;
const URL = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;
const imagePaths = (text) => [...text.matchAll(IMAGE_PATH)].map((m) => m[1] ?? m[2]);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const quoted = (p) => (/\s/.test(p) ? `"${p}"` : p);
const hash = (s) => [...s].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(36);
const short = (url) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/(.{48}).+/, "$1…");

// Saves the clipboard's image as a PNG file (macOS); prints nothing when it holds none.
const PASTE_SH = `osascript -e 'try' -e 'set d to the clipboard as «class PNGf»' -e 'set f to open for access POSIX file "'"$1"'" with write permission' -e 'write d to f' -e 'close access f' -e 'return "ok"' -e 'end try'`;

const WORD = { working: "working", blocked: "needs you", done: "done", idle: "idle" };

export default class Chat extends View {
  init(_props, cx) {
    // Read-only: a transcript file instead of a terminal.
    this.file = props()?.transcript ?? null;
    this.codex = Boolean(this.file) && isCodex(this.file);
    this.address = this.file ? null : props()?.terminal ?? focused()?.terminal ?? null;
    // The selection prompt on the terminal's screen, and until when to keep looking for one.
    this.prompt = null;
    this.suspect = Date.now() + 5000;
    this.messages = [];
    this.error = null;
    this.limit = SHOWN;
    this.tail = TAIL;
    this.open = new Set();
    this.seen = "";
    this.sendError = null;
    // How far the feed is scrolled up from the newest message, and the sizes that bound it.
    this.offset = 0;
    this.viewH = 0;
    this.contentH = 0;
    this.reply = TextareaState.new({ placeholder: "Message Claude…  (paste or drop images and files)", rows: 2 });
    this.reply.set_auto_grow(2, 8);
    // Enter sends; Shift+Enter starts a new line.
    this.reply.on("submit", (e, cx) => (e?.shift ? this.reply.replace("\n") : this.send(cx)));
    this.reply.on("change", (_e, cx) => { this.typed = this.reply.value(); cx.notify(); });
    this.reply.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.typed = "";
    // Files pasted or dropped into the message ({ path, image }): shown above it, their paths sent with it.
    this.attachments = [];
    // image() only loads files under the app folder, so every picture shown is copied here first.
    this.cache = `${appHome()}/mods/chat/.cache`;
    this.cached = new Set();
    // Image paths outside the cache → their copy in it.
    this.copies = new Map();
    // Sent but not in the transcript yet.
    this.outbox = [];
    this.commands = BUILTIN.map(([name, about]) => ({ name, about }));
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", SKILLS_SH], { cwd: this.terminal()?.cwd ?? home() });
      const skills = r.stdout.split("\n").filter(Boolean).map((l) => { const [name, about] = l.split("\t"); return { name, about: (about ?? "").replace(/^["']|["']$/g, "") }; });
      const seen = new Set(this.commands.map((c) => c.name));
      this.commands.push(...skills.filter((c) => !seen.has(c.name) && seen.add(c.name)));
      cx.notify();
    });
    // The loop ends with this copy; sleeping through exec keeps it off the UI thread.
    cx.spawn(async (cx) => {
      for (;;) {
        const a = await this.reload();
        const b = await this.watchScreen();
        if (a || b) cx.notify();
        await exec("sleep", [POLL_S]);
      }
    });
  }

  status() {
    if (this.file) return this.messages.working ? "working" : null;
    const agent = agents().find((a) => a.address === this.address);
    return agent?.status ?? (this.terminal()?.state === "live" ? null : "done");
  }

  // Reads the screen only while a prompt is likely: blocked, starting, just sent a command, or one showing.
  async watchScreen() {
    if (!this.address || !this.terminal()) return false;
    const status = this.status();
    if (!(status === "blocked" || !status || this.prompt || Date.now() < this.suspect)) return false;
    const next = await this.readPrompt();
    const changed = JSON.stringify(next) !== JSON.stringify(this.prompt);
    this.prompt = next;
    return changed;
  }

  async readPrompt() {
    const r = await hc(["read", this.address]);
    if (r.code !== 0) return null;
    let text = r.stdout;
    try { text = JSON.parse(text).text ?? text; } catch {}
    return screenPrompt(text);
  }

  // Presses an option, with keys worked out from the screen as it is now.
  answer(o, cx) {
    this.prompt = null;
    this.suspect = Date.now() + 6000;
    cx.notify();
    cx.spawn(async (cx) => {
      const now = await this.readPrompt();
      const pick = now?.options.find((x) => x.label === o.label && x.n === o.n);
      if (pick) await hc(["keys", this.address, ...pick.keys]);
      this.prompt = pick ? null : now;
      cx.notify();
    });
  }

  stop(cx) {
    cx.spawn(async (cx) => {
      const r = await hc(["interrupt", this.address]);
      this.sendError = r.code === 0 ? null : r.stderr.trim() || "Couldn't stop.";
      this.suspect = Date.now() + 4000;
      cx.notify();
    });
  }

  // Where image() can load a picture from (relative to the app folder), or null until it's copied.
  shown(path) {
    const root = `${appHome()}/`;
    if (path.startsWith(root)) return path.slice(root.length);
    const copy = this.copies.get(path);
    return copy ? copy.slice(root.length) : null;
  }

  // Copies pictures from outside the app folder into the cache; true when any were new.
  async copyImages(paths) {
    const fresh = [...new Set(paths)].filter((p) => !p.startsWith(`${appHome()}/`) && !this.copies.has(p));
    if (!fresh.length) return false;
    await exec("mkdir", ["-p", this.cache]);
    for (const p of fresh) {
      const copy = `${this.cache}/img-${hash(p)}.${p.split(".").pop().toLowerCase()}`;
      const r = await exec("cp", [p, copy]);
      // A missing file stays missing: remember it so it isn't retried every poll.
      this.copies.set(p, r.code === 0 ? copy : null);
    }
    return true;
  }

  terminal() {
    return terminals().find((t) => t.address === this.address);
  }

  // Re-reads the transcript's tail; true when something changed.
  async reload() {
    const term = this.terminal();
    const session = term?.records?.session?.app;
    const error = this.file ? null
      : !this.address ? "Focus a Claude tab, then open chat (⌘⇧K)."
      : !term ? "That terminal has closed."
      : !session ? "Waiting for this Claude to say which session it is. It will after its next message or tool call."
      : null;
    // A chat view opened by the CLI / Chat switch goes with its terminal.
    if (this.address && !term && closeWith(this.address)) return false;
    if (error) {
      const changed = error !== this.error;
      this.error = error;
      return changed;
    }
    const path = this.file ?? transcriptPath(home(), term.cwd ?? "", dashed(session));
    const r = await exec("tail", ["-c", String(this.tail), path]);
    if (r.code !== 0) {
      this.error = `Can't read the transcript: ${r.stderr.trim()}`;
      return true;
    }
    const mark = `${r.stdout.length}:${r.stdout.slice(-200)}`;
    if (mark === this.seen && !this.error) return false;
    this.seen = mark;
    this.error = null;
    this.messages = this.codex ? parseCodex(r.stdout) : parse(r.stdout);
    this.truncated = r.stdout.length >= this.tail;
    // Pasted images live in the transcript as base64: write new ones out so they can be shown.
    const fresh = this.messages.flatMap((m) => m.images ?? []).filter((n) => !this.cached.has(n));
    if (fresh.length) {
      await exec("python3", ["-c", imagesScript, path, this.cache]);
      fresh.forEach((n) => this.cached.add(n));
    }
    const said = this.messages.flatMap((m) => [m.text ?? "", ...(m.parts ?? []).map((x) => x.text ?? "")]);
    await this.copyImages(said.flatMap(imagePaths).map((p) => p.replace(/^~/, home())));
    const users = this.messages.filter((m) => m.role === "user").length;
    const sent = new Set(this.messages.filter((m) => m.role === "user").map((m) => m.text));
    this.outbox = this.outbox.filter((o) => !sent.has(o.text) && users <= o.users && Date.now() - o.at < 20000);
    return true;
  }

  setText(text, cx) {
    this.reply.set_value(text);
    this.typed = text;
    cx.notify();
  }

  // A screenshot pasted into the message box: saved as a file, its path added to the message.
  pasteImage(cx) {
    cx.spawn(async (cx) => {
      const file = `${this.cache}/paste-${Date.now()}.png`;
      await exec("mkdir", ["-p", this.cache]);
      const r = await exec("sh", ["-c", PASTE_SH, "sh", file]);
      if (!r.stdout.includes("ok")) return;
      this.attachments.push({ path: file, image: true });
      cx.notify();
    });
  }

  // Commands matching a "/word" being typed (nothing once it has a space).
  suggestions() {
    const m = /^\/([\w:.-]*)$/.exec(this.typed.trim());
    if (!m) return [];
    const q = m[1].toLowerCase();
    return this.commands.filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)).slice(0, 8);
  }

  pick(c, cx) {
    this.reply.set_value(`/${c.name} `);
    this.typed = `/${c.name} `;
    cx.notify();
  }

  send(cx) {
    const words = this.reply.value().trim();
    const text = [words, ...this.attachments.map((a) => quoted(a.path))].filter(Boolean).join(" ");
    if (!text || !this.address) return;
    if (!agents().some((a) => a.address === this.address && a.status)) {
      this.sendError = "Claude is still starting. Send again in a moment.";
      return cx.notify();
    }
    // Enter on a half-typed command completes it, like the terminal does.
    const list = this.suggestions();
    if (list.length && !list.some((c) => `/${c.name}` === words)) return this.pick(list[0], cx);
    this.attachments = [];
    this.reply.set_value("");
    this.typed = "";
    // Commands like /model answer with a picker.
    if (text.startsWith("/")) this.suspect = Date.now() + 20000;
    this.outbox.push({ text, at: Date.now(), users: this.messages.filter((m) => m.role === "user").length });
    this.offset = 0;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", "--json", this.address, text]);
      // A paste can land without its Enter (Claude busy redrawing): press it once more.
      let started = true;
      try { started = JSON.parse(r.stdout).started === true; } catch {}
      if (r.code === 0 && !started) {
        await exec("sleep", ["0.4"]);
        await hc(["keys", this.address, "enter"]);
      }
      this.sendError = r.code === 0 ? null
        : r.code === 9 ? "Claude is waiting on a question or permission. Answer it first."
        : r.stderr.trim() || "Couldn't send.";
      if (r.code !== 0) {
        this.outbox = this.outbox.filter((o) => o.text !== text);
        if (!this.reply.value()) this.reply.set_value(text);
      }
      cx.notify();
    });
  }

  showTerminal() {
    // Opened by the pane header's CLI / Chat switch: switch back to the CLI instead.
    if (toCli(this.address)) return;
    run("agent.focus", { terminal: this.address });
  }

  close() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  // Consecutive tool calls as one chip that expands to a line per call.
  steps(t, tools, key) {
    const open = this.open.has(key);
    const running = tools.some((x) => x.status === "running");
    const failed = tools.filter((x) => x.status === "error").length;
    const names = Object.entries(tools.reduce((m, x) => ({ ...m, [x.name]: (m[x.name] ?? 0) + 1 }), {}))
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).slice(0, 4).join(", ");
    return v_flex().gap(4)
      .child(h_flex().id(`steps-${key}`).gap(6).items_center().self_start().px(8).py(3).rounded(8)
        .bg(t.surface).border(1).border_color(t.border).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { open ? this.open.delete(key) : this.open.add(key); cx.notify(); })
        .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.muted))
        .child(div().text_size(11.5).text_color(t.muted)
          .child(`${tools.length} step${tools.length === 1 ? "" : "s"} · ${names}`))
        .when(running, (el) => el.child(div().text_size(11).text_color(t.working)
          .loop("opacity", { from: 0.3, to: 1, period: 900 }).child("running")))
        .when(failed > 0, (el) => el.child(div().text_size(11).text_color(t.blocked).child(`${failed} failed`))))
      .when(open, (el) => el.child(v_flex().gap(2).pl(8).children(tools.map((x) =>
        h_flex().gap(6).items_start().text_size(11)
          .child(div().w(12).flex_none().text_color(x.status === "error" ? t.blocked : x.status === "running" ? t.working : t.done)
            .child(x.status === "error" ? "✕" : x.status === "running" ? "…" : "✓"))
          .child(div().flex_none().font_semibold().text_color(t.foreground).child(x.name))
          .child(div().flex_1().min_w(0).text_color(t.muted).child(x.error ? `${x.summary} — ${x.error}` : x.summary))))));
  }

  // Markdown, with image paths drawn as pictures and bare links made clickable.
  prose(id, text) {
    const pics = imagePaths(text);
    const body = text.replace(IMAGE_PATH, "").replace(/\[Image #\d+\]/g, "").trim();
    const t = theme();
    return v_flex().gap(6)
      .when(pics.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(pics.map((p, k) =>
        this.thumb(t, p.replace(/^~/, home()), `${id}-${k}`)))))
      .when(Boolean(body), (el) => el.child(TextView.markdown(id, body).selectable(true)));
  }

  // A picture (absolute path), or a file tile when it isn't a picture or isn't copied in yet.
  thumb(t, path, key, remove, w = 200, h = 140) {
    const src = IMAGE.test(path) ? this.shown(path) : null;
    return div().id(`img-${key}`).relative().rounded(8).overflow_hidden().border(1).border_color(t.border)
      .cursor_pointer().hover((s) => s.opacity(0.9))
      .on_click((_e, cx) => cx.open_url(`file://${path}`))
      .child(src ? image(src).w(w).h(h)
        : h_flex().h(Math.min(h, 40)).max_w(220).gap(6).items_center().pl(8).pr(remove ? 28 : 10).bg(t.surface)
          .child(svg(`${ICONS}/file-text.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(path.split("/").pop())))
      .when(Boolean(remove), (el) => el.child(div().id(`rm-${key}`).absolute().top(src ? 4 : 11).right(4).size(18).flex().items_center()
        .justify_center().rounded(9).bg(t.solid).text_size(11).text_color(t.solid_foreground)
        .on_click((_e, cx) => { cx.stop_propagation(); remove(cx); }).child("×")));
  }

  // The prompt on the terminal's screen: what it shows, the question, an answer button per option.
  promptCard(t, p) {
    return v_flex().id("prompt").mx(12).mb(8).px(12).py(10).gap(8).rounded(10)
      .bg(`${t.blocked}14`).border(1).border_color(`${t.blocked}66`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(p.context.length > 0, (el) => el.child(v_flex().gap(1).px(8).py(6).rounded(6).bg(t.background)
        .children(p.context.map((l) => div().truncate().font_family("monospace").text_size(11).text_color(t.muted).child(l)))))
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(p.question))
      .child(v_flex().gap(4).children(p.options.map((o, k) => h_flex().id(`opt-${k}`).gap(8).items_start().px(10).py(6)
        .rounded(7).border(1).border_color(o.selected ? t.blocked : t.border).bg(t.background).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.answer(o, cx))
        .child(div().w(14).flex_none().text_size(12).text_color(t.muted).child(o.n ? `${o.n}` : "›"))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
          .when(Boolean(o.about), (el) => el.child(div().text_size(11).text_color(t.muted).child(o.about)))))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(10.5).text_color(t.dim).child("Click an answer, or answer in the terminal"))
        .child(div().id("prompt-terminal").px(8).py(3).rounded(6).border(1).border_color(t.border)
          .text_size(11).text_color(t.foreground).hover((s) => s.bg(t.hover))
          .on_click(() => this.showTerminal()).child("Open terminal")));
  }

  message(t, m, i) {
    // What a command printed: its first lines, the rest a click away.
    if (m.role === "output") {
      const key = `o-${i}`;
      const open = this.open.has(key);
      const lines = m.text.split("\n").filter((l) => l.trim() && !/^\s*\|?[-:| ]+\|?\s*$/.test(l));
      const long = lines.length > 3;
      return v_flex().id(key).w_full().px(12).py(8).gap(6).rounded(10).bg(t.surface).border(1).border_color(t.border)
        .when(long, (el) => el.cursor_pointer().on_click((_e, cx) => { open ? this.open.delete(key) : this.open.add(key); cx.notify(); }))
        .child(open || !long
          ? div().text_size(12).child(TextView.markdown(key, m.text))
          : v_flex().gap(2).children(lines.slice(0, 3).map((l) => div().truncate().text_size(12).text_color(t.foreground)
            .child(l.replace(/[#*`|]/g, " ").replace(/\s+/g, " ").trim()))))
        .when(long, (el) => el.child(h_flex().gap(4).items_center()
          .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.muted))
          .child(div().text_size(11).text_color(t.muted).child(open ? "Show less" : `Show all ${lines.length} lines`))));
    }
    if (m.role === "user" && m.command) {
      return h_flex().w_full().justify_end().child(
        div().px(10).py(5).rounded(8).border(1).border_color(`${t.accent}66`).bg(`${t.accent}14`)
          .font_family("monospace").text_size(12).text_color(t.foreground).child(m.text));
    }
    if (m.role === "user") {
      return v_flex().w_full().items_end().gap(3).child(
        v_flex().max_w("85%").px(12).py(8).rounded(14).bg(`${t.accent}22`).gap(4)
          .when(Boolean(m.queued || m.sending), (el) => el.opacity(0.6))
          .when(m.images.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(m.images.map((n) =>
            this.thumb(t, `${this.cache}/${n}`, `${i}-${n}`)))))
          .when(Boolean(m.text), (el) => el.child(this.prose(`u-${i}`, m.text))))
        .when(Boolean(m.queued || m.sending), (el) => el.child(div().text_size(10.5).text_color(t.muted)
          .child(m.queued ? "Queued · Claude will read it when it finishes" : "Sending…")));
    }
    // Text parts as markdown; runs of tool calls folded into one chip each.
    const blocks = [];
    for (const part of m.parts) {
      const last = blocks[blocks.length - 1];
      if (part.kind === "tool") {
        if (last?.tools) last.tools.push(part);
        else blocks.push({ tools: [part] });
      } else blocks.push(part);
    }
    return v_flex().w_full().gap(8).pr(24).children(blocks.map((b, j) => b.tools
      ? this.steps(t, b.tools, `${i}-${j}`)
      : div().w_full().child(this.prose(`a-${i}-${j}`, b.text))));
  }

  render() {
    const t = theme();
    const term = this.terminal();
    const agent = agents().find((a) => a.address === this.address);
    const status = this.status();
    const who = this.codex ? "Codex" : "Claude";
    const color = { working: t.working, blocked: t.blocked, done: t.done }[status] ?? t.dim;
    const said = new Set(this.messages.filter((m) => m.role === "user").map((m) => m.text));
    const pending = this.outbox.filter((o) => !said.has(o.text))
      .map((o) => ({ role: "user", text: o.text, images: [], sending: true, command: o.text.startsWith("/") }));
    const shown = [...this.messages, ...pending].slice(-this.limit);
    const hidden = this.messages.length + pending.length - shown.length;

    const header = h_flex().px(14).py(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().size(8).rounded(4).bg(color)
        .when(status === "working", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1000 })))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground)
          .child(props()?.title || agent?.title || term?.title || who))
        .child(div().truncate().text_size(11).text_color(t.muted)
          .child([WORD[status], agent ? `${agent.space_name} / ${agent.tab_name}` : null, this.address,
            this.file?.replace(home(), "~")].filter(Boolean).join(" · "))))
      .when(status === "working" && Boolean(this.address), (el) => el.child(h_flex().id("stop").gap(5).items_center().px(8).py(4)
        .rounded(6).border(1).border_color(`${t.blocked}88`).hover((s) => s.bg(`${t.blocked}22`))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.stop(cx))
        .child(svg(`${ICONS}/square.svg`).size(11).text_color(t.blocked))
        .child(div().text_size(11.5).text_color(t.foreground).child("Stop"))))
      .when(Boolean(this.address), (el) => el.child(h_flex().id("to-terminal").gap(5).items_center().px(8).py(4).rounded(6).border(1).border_color(t.border)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.showTerminal())
        .child(svg(`${ICONS}/terminal.svg`).size(12).text_color(t.muted))
        .child(div().text_size(11.5).text_color(t.foreground).child("Terminal"))))
      .when(Boolean(props()?.overlay), (el) => el.child(div().id("close").p(4).rounded(6).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.close())
        .child(svg(`${ICONS}/x.svg`).size(14).text_color(t.muted))));

    // GPUI scroll areas rest at the top, so the feed scrolls itself: its content is pinned to the
    // bottom edge and the wheel moves it, keeping the newest message in view by default.
    const zoom = Number(settings().zoom) || 1;
    const maxOffset = Math.max(0, this.contentH - this.viewH);
    const offset = Math.min(this.offset, maxOffset);
    const content = v_flex().id("feed-content").absolute().left(0).right(0).bottom(-offset).px(16).py(12).gap(14)
      .on_size_change((size, cx) => { this.contentH = size.height / zoom; cx.notify(); })
      .when(hidden > 0 || this.truncated, (el) => el.child(div().id("earlier").self_center().px(10).py(4).rounded(8)
        .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (hidden > 0) this.limit += SHOWN;
          else this.tail *= 4;
          this.seen = "";
          cx.spawn(async (cx) => { await this.reload(); cx.notify(); });
        })
        .child("Show earlier")))
      .children(shown.map((m, k) => this.message(t, m, hidden + k)))
      .when(status === "working", (el) => el.child(h_flex().gap(6).items_center()
        .child(div().text_size(12).text_color(t.working).frames(["●  ", "●● ", "●●●", " ●●", "  ●", "   "], 220))
        .child(div().text_size(11.5).text_color(t.muted).child(`${who} is working`))));
    const feed = div().id("feed").relative().flex_1().min_h(0).overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_size_change((size, cx) => { this.viewH = size.height / zoom; cx.notify(); })
      .on_scroll_wheel((e, cx) => {
        this.offset = Math.max(0, Math.min(this.offset + e.delta.y, Math.max(0, this.contentH - this.viewH)));
        cx.notify();
      })
      .child(content)
      .when(offset > 40, (el) => el.child(div().id("latest").absolute().bottom(10).right(16).px(10).py(5).rounded(12)
        .bg(t.solid).text_size(11).text_color(t.solid_foreground).hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => { this.offset = 0; cx.notify(); })
        .child("Jump to latest ↓")));

    const banner = this.prompt ? this.promptCard(t, this.prompt) : status === "blocked" && h_flex().mx(12).mb(8).px(12).py(8).gap(8).items_center().rounded(10)
      .bg(`${t.blocked}1f`).border(1).border_color(`${t.blocked}66`)
      .child(div().flex_1().text_size(12).text_color(t.foreground).child("Claude needs you: a question or permission is waiting in the terminal."))
      .child(div().id("answer").px(10).py(4).rounded(6).bg(t.blocked).text_size(11.5).text_color("#ffffff")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.showTerminal()).child("Open terminal"));

    const list = this.suggestions();
    const menu = list.length > 0 && v_flex().id("slash").mx(12).mb(6).p(4).rounded(10).border(1).border_color(t.border)
      .bg(t.background).shadow_md()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(list.map((c, k) => h_flex().id(`slash-${c.name}`).gap(10).items_center().px(8).py(5).rounded(6)
        .when(k === 0, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pick(c, cx))
        .child(div().flex_none().font_family("monospace").text_size(12).text_color(t.foreground).child(`/${c.name}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(c.about))))
      .child(div().px(8).pt(4).text_size(10.5).text_color(t.dim).child("Enter picks the first · click to pick"));

    // What's in the message besides words: files (pictures as thumbnails), each removable, and links.
    const files = this.attachments;
    const links = [...new Set(this.typed.match(URL) ?? [])];
    const attached = (files.length > 0 || links.length > 0) && h_flex().flex_wrap().gap(6).items_center()
      .children(files.map((a, k) => this.thumb(t, a.path, `draft-${k}`, (cx) => {
        this.attachments = this.attachments.filter((x) => x !== a);
        cx.notify();
      }, 96, 68)))
      .children(links.map((u, k) => h_flex().id(`link-${k}`).gap(5).items_center().px(8).py(3).rounded(6)
        .bg(t.background).border(1).border_color(t.border).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => cx.open_url(u))
        .child(svg("mods/jira-preview/link.svg").size(11).text_color(t.muted))
        .child(div().text_size(11.5).text_color(t.accent).child(short(u)))));
    const composer = this.file
      ? h_flex().px(14).py(9).gap(6).items_center().border_t(1).border_color(t.border).bg(t.chrome)
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.muted)
          .child(`Read-only: this ${who} session runs outside Herdr. Reply to it where it's running.`))
      : v_flex().px(12).pb(12).pt(10).gap(6).border_t(1).border_color(t.border).bg(t.chrome)
      .when(Boolean(attached), (el) => el.child(attached))
      .when(Boolean(this.sendError), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.sendError)))
      .child(h_flex().gap(8).items_end()
        .child(div().id("reply").flex_1().min_w(0).rounded(10).border(1).border_color(t.input).bg(t.background).px(10).py(6)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_drop((event, cx) => {
            const dropped = (event.paths ?? []).filter((p) => !this.attachments.some((a) => a.path === p));
            this.attachments.push(...dropped.map((p) => ({ path: p, image: IMAGE.test(p) })));
            cx.notify();
            cx.spawn(async (cx) => { if (await this.copyImages(dropped.filter((p) => IMAGE.test(p)))) cx.notify(); });
          })
          .child(Textarea.new(this.reply).text_size(13).text_color(t.foreground)))
        .child(div().id("send").px(14).py(8).rounded(10).bg(t.solid).text_size(12.5).font_semibold()
          .text_color(t.solid_foreground).hover((s) => s.opacity(0.85))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.send(cx)).child("Send")));

    return v_flex().size_full().bg(t.background)
      .child(header)
      .child(this.error
        ? div().flex_1().p(20).text_size(12.5).text_color(t.muted).child(this.error)
        : feed)
      .when(Boolean(banner), (el) => el.child(banner))
      .when(Boolean(menu), (el) => el.child(menu))
      .child(composer);
  }
}
