// The pond: every agent is a Claude critter (Codex ones wear a brass diving suit) acting out what
// it's doing right now: thinking, reading, editing, running commands, browsing or delegating. Working ones swim laps trailing bubbles, ones
// that need you bounce at the surface, done ones rest on the sand with a sparkle, idle ones
// sleep. Sub-agents paddle behind their parent as babies; when one finishes it grows and swims up
// out of the pond; each baby wears a badge for what it's doing and says its task on hover. Click a critter to jump to its agent,
// right-click it to open its chat view beside it; "+ Claude" starts a new one in the shown space.
// Water and sand follow the app's light or dark appearance; the deck layout draws a sonar tank at night
// and the lcars one a black viewscreen framed by bars.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, run, theme, settings, terminals, panes, focused, exec, openOverlay, nextCommand, home, shared, setShared } from "herdr";
import { toChat, closeWith, modes, focusAgent, convert } from "./mode.js";
import { serveInspect } from "./inspect.js";
import { openChanges } from "./changes.js";
import { setup } from "./setup.js";
import { style, label as caps, rad, badge as letterBadge, heading, brackets, LETTER } from "./style.js";

const ART = "mods/field";
const CRITTER = 44;
const SAND = 30;
const BABY = 18;
const BABY_GAP = BABY + 4;
const MAX_BABIES = 6;
const LEAVE_MS = 3200;
// The "Elsewhere" lane: sessions running outside Herdr.
const LANE_W = 150;
const OUTSIDE_MAX = 4;
const OUTSIDE_MS = 20000;
const STATS_MS = 30000;
// A chat-only tab is closed once it's been seen orphaned this long.
const ORPHAN_MS = 4000;
// Agents already running this soon after the pond starts keep their terminal (Herdr loading them).
const SETTLE_MS = 5000;

// Rough API prices, $ per million tokens: model pattern, input, output, cache read. Cache writes
// bill 1.25× input (5 min) or 2× (1 h). An estimate: plans and discounts aren't known here.
const PRICES = [
  ["fable|mythos", 10, 50, 0.25],
  ["opus-5-5", 4, 20, 0.2],
  ["opus", 5, 25, 0.5],
  ["sonnet-5", 2, 10, 0.2],
  ["sonnet", 3, 15, 0.3],
  ["haiku-5", 0.1, 0.5, 0.01],
  ["haiku", 1, 5, 0.1],
];

// Token use and cost of a Claude session, its sub-agents included: each assistant message's
// last usage record. Args: session id (dashed), PRICES as JSON.
const STATS_PY = String.raw`
import json, sys, glob, os, re
sid, prices = sys.argv[1], json.loads(sys.argv[2])
root = os.path.expanduser("~/.claude/projects/*/")
paths = glob.glob(root + sid + ".jsonl") + glob.glob(root + sid + "/subagents/*.jsonl")
seen = {}
for p in paths:
    for l in open(p, errors="replace"):
        if '"usage"' not in l: continue
        try: r = json.loads(l)
        except Exception: continue
        m = r.get("message") or {}
        if r.get("type") == "assistant" and m.get("usage"): seen[m.get("id") or r.get("uuid")] = (m.get("model") or "", m["usage"])
tok = cost = 0
for model, u in seen.values():
    i, o = u.get("input_tokens") or 0, u.get("output_tokens") or 0
    cr, cw = u.get("cache_read_input_tokens") or 0, u.get("cache_creation_input_tokens") or 0
    h1 = (u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0
    tok += i + o + cr + cw
    p = next((x[1:] for x in prices if re.search(x[0], model)), None)
    if p: cost += (i * p[0] + o * p[1] + cr * p[2] + (cw - h1) * p[0] * 1.25 + h1 * p[0] * 2) / 1e6
print(json.dumps({"found": bool(paths), "tok": tok, "cost": cost}))
`;

// Claude and Codex sessions written to in the last 15 minutes that aren't a Herdr terminal's
// (argv[1]: those ids, undashed, comma-separated), newest first. Sub-agents, headless runs and
// Codex tasks a Claude session started (its codex plugin) are skipped.
const OUTSIDE_PY = String.raw`
import json, sys, glob, os, re, time
skip, now, home = set(sys.argv[1].split(",")), time.time(), os.path.expanduser("~")
def lines(p, end=False, n=262144):
    with open(p, "rb") as f:
        if end: f.seek(0, 2); f.seek(max(0, f.tell() - n))
        out = []
        for l in f.read(n).decode("utf-8", "replace").splitlines():
            try: out.append(json.loads(l))
            except Exception: pass
        return out
def said(c):
    if isinstance(c, list): c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") in ("text", "input_text"))
    c = (c or "").strip() if isinstance(c, str) else ""
    return c if c and not c.startswith("<") and not c.startswith("# AGENTS.md") else None
found = []
for p in glob.glob(home + "/.claude/projects/*/*.jsonl"):
    sid, at = os.path.basename(p)[:-6], os.path.getmtime(p)
    if now - at > 900 or sid.startswith("agent-") or sid.replace("-", "") in skip: continue
    head, cwd, first, side, entry = lines(p), None, None, False, None
    for r in head:
        side, cwd, entry = side or bool(r.get("isSidechain")), cwd or r.get("cwd"), entry or r.get("entrypoint")
        if first is None and r.get("type") == "user": first = said((r.get("message") or {}).get("content"))
    titles = {}
    for r in lines(p, True):
        cwd, entry = r.get("cwd") or cwd, r.get("entrypoint") or entry
        for k in ("customTitle", "aiTitle"):
            if r.get(k): titles[k] = r[k]
    if side or (entry or "").startswith("sdk"): continue
    found.append({"kind": "claude", "id": sid, "path": p, "at": at, "cwd": cwd, "app": entry,
                  "title": titles.get("customTitle") or titles.get("aiTitle") or first})
names = {}
try:
    for r in lines(home + "/.codex/session_index.jsonl", True, 1048576): names[r.get("id")] = r.get("thread_name")
except Exception: pass
for p in glob.glob(home + "/.codex/sessions/*/*/*/rollout-*.jsonl"):
    at, m = os.path.getmtime(p), re.search(r"([0-9a-f-]{36})\.jsonl$", p)
    if now - at > 900 or not m or m.group(1).replace("-", "") in skip: continue
    head = lines(p)
    meta = next((r.get("payload") or {} for r in head if r.get("type") == "session_meta"), {})
    if isinstance(meta.get("source"), dict) or meta.get("parent_thread_id") or meta.get("originator") == "Claude Code": continue
    first = next((said(r["payload"].get("content")) for r in head if r.get("type") == "response_item"
                  and (r.get("payload") or {}).get("role") == "user" and said(r["payload"].get("content"))), None)
    name = re.sub(r"^Codex Companion Task:\s*", "", names.get(m.group(1)) or "")
    found.append({"kind": "codex", "id": m.group(1), "path": p, "at": at, "cwd": meta.get("cwd"), "app": "codex", "title": name or first})
found.sort(key=lambda x: -x["at"])
print(json.dumps(found[:int(sys.argv[2])]))
`;

const dashed = (id) => (id.length === 32 ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : id);
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const resting = (a) => a.status === "done" || a.status === "idle";

const isCodex = (app) => /codex/i.test(app ?? "");

// The tool an agent's hooks say it's using (its "tool" record), as an activity to act out.
const ACTIVITIES = [
  [/^think$/, "think"],
  [/^(Read|Grep|Glob|LS|NotebookRead)$/, "read"],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, "edit"],
  [/^(Bash|BashOutput|KillShell|KillBash)$/, "run"],
  [/^(WebFetch|WebSearch)$|^mcp/, "web"],
  [/^(Task|Agent)$/, "delegate"],
];
const VERB = { think: "thinking", read: "reading", edit: "editing", run: "running", web: "browsing", delegate: "delegating" };

// A tool record ("tool", or a sub-agent's "<id>.t") as an activity; null when it isn't saying.
const activityOf = (r) => r?.state === "working" && r.app && r.app !== "none"
  ? { kind: ACTIVITIES.find(([re]) => re.test(r.app))?.[1] ?? "tool", tool: r.app }
  : null;
const doing = (act) => (act ? VERB[act.kind] ?? act.tool : null);
// Record values can't hold spaces, so a sub-agent's task ("<id>.d") travels with dashes.
const prose = (v) => v?.replace(/-+/g, " ").trim() || null;
const kind = (type) => (type === "general-purpose" ? "agent" : type);

const since = (ms) => {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

const SCENES = {
  dark: {
    water: ["#1d3a63", "#183358", "#142c4e", "#112644", "#0e203a", "#0b1a30"],
    sand: "#3b3328", sandEdge: "#4a4032", glint: "#ffffff22",
    ink: "#eef1ff", muted: "#a3abcf", dim: "#6f789e",
    label: "#0b1a30cc", labelInk: "#eef1ff", card: "#0b1a30f2", bubble: "#ffffff55", button: "#eef1ff", buttonInk: "#10233a",
  },
  light: {
    water: ["#d6f0fa", "#c3e8f6", "#afe0f2", "#9cd7ed", "#89cde7", "#77c2e0"],
    sand: "#f2dfb2", sandEdge: "#e6cd92", glint: "#ffffff99",
    ink: "#10233a", muted: "#3d5a75", dim: "#5f7a92",
    label: "#ffffffd9", labelInk: "#10233a", card: "#fffffff5", bubble: "#ffffffaa", button: "#10233a", buttonInk: "#ffffff",
  },
  deck: {
    water: ["#0a1015", "#091014", "#080e12", "#070c10", "#060a0d", "#05080a"],
    sand: "#0a0c0e", sandEdge: "#1e262f", glint: "#3fd2c733",
    ink: "#c8d0d9", muted: "#8b96a3", dim: "#5c6773",
    label: "#06080ae6", labelInk: "#c8d0d9", card: "#0a0d11f7", bubble: "#3fd2c766", button: "#ff9e3d", buttonInk: "#0c0f13",
    grid: "#3fd2c714", sweep: "#3fd2c7",
  },
  lcars: {
    water: ["#000000", "#010103", "#020206", "#030309", "#03040c", "#04050f"],
    sand: "#000000", sandEdge: "#000000", glint: "#cc99cc44",
    ink: "#f2e3c6", muted: "#c9a873", dim: "#7a6a50",
    label: "#000000e6", labelInk: "#f2e3c6", card: "#0b0b0bf7", bubble: "#9999ff66", button: "#ff9900", buttonInk: "#000000",
  },
};

const WORD = { working: "working", blocked: "needs you", done: "done", idle: "resting" };

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// What kind of work a task is, from words in its title; the first match wins.
const ROLES = [
  [/\b(docs?|readme|writ\w*|copy|descriptions?)\b/i, "Scribe"],
  [/\b(reviews?|reviewing|pr|prs|pull requests?)\b/i, "Reviewer"],
  [/\b(errors?|bugs?|fix|fixes|fixing|fail\w*|broken|crash\w*|regressions?)\b/i, "Fixer"],
  [/\b(tests?|testing|specs?|coverage)\b/i, "Tester"],
  [/\b(refactor\w*|clean\w*|tidy\w*|simplif\w*)\b/i, "Tidier"],
  [/\b(investigat\w*|debug\w*|spikes?|research\w*|explor\w*|why|diagnos\w*)\b/i, "Sleuth"],
  [/\b(plan\w*|design\w*|architect\w*)\b/i, "Planner"],
  [/\b(migrat\w*|upgrad\w*)\b/i, "Mover"],
  [/\b(deploy\w*|releas\w*|ship\w*)\b/i, "Shipper"],
  [/\b(add\w*|build\w*|implement\w*|creat\w*|features?|new)\b/i, "Builder"],
];
const FILLER = new Set(["a", "an", "the", "of", "for", "in", "on", "to", "and", "with", "my", "our", "this", "that", "from",
  "claude", "code", "task", "issue", "issues", "problem", "problems", "stuff", "work"]);
const NICKNAMES = ["Pip", "Nib", "Mo", "Juno", "Ziggy", "Bea", "Otto", "Kit", "Remy", "Dot"];

// A short name from the agent's live task title: a subject plus a role, like "Type Check Fixer".
// The title changes as the work does, so the name does too. With `px`, the longest of
// "Type Check Fixer", "Type Check", "Type Fixer", "Type" that fits that width.
function nickname(a, px = Infinity) {
  const title = (a.title ?? "").replace(/^[^\p{L}\p{N}#]+/u, "").trim();
  if (!title || /^claude( code)?$/i.test(title)) return NICKNAMES[hash(a.address) % NICKNAMES.length];
  const [match, role] = ROLES.find(([re]) => re.test(title)) ?? [null, "Helper"];
  const subject = title.split(/\s+/)
    .filter((w) => !FILLER.has(w.toLowerCase()) && !(match && new RegExp(`^${match.source}$`, "i").test(w)))
    .slice(0, 2)
    .map((w) => (/^\d+$/.test(w) ? `#${w}` : w[0].toUpperCase() + w.slice(1)));
  if (!subject.length) return role;
  const [first, second] = subject;
  const tries = [[...subject, role], second ? subject : null, second ? [first, role] : null, [first]].filter(Boolean).map((t) => t.join(" "));
  // About 5.3px a character at the label's 10px semibold.
  return tries.find((n) => n.length * 5.3 <= px) ?? tries.at(-1);
}

export default class Field extends View {
  init(_props, cx) {
    serveInspect(cx);
    cx.spawn(async (cx) => {
      const cfg = await setup();
      for (const w of cfg.pond?.ignore_words ?? []) FILLER.add(w.toLowerCase());
      this.chatDefault = cfg.chat?.default !== false;
      cx.notify();
    });
    this.size = { width: 900, height: 220 };
    // Babies seen working, and when each one started leaving.
    this.seen = new Set();
    this.leaving = new Map();
    // Only to drop babies whose swim-away has finished; quiet otherwise.
    cx.timer.every(1500, (cx) => { if (this.leaving.size) cx.notify(); });
    // Keeps the minutes on labels current, and the hovered agent's usage.
    cx.timer.every(30000, (cx) => {
      const a = agents().find((x) => x.address === this.hovered);
      if (a) this.loadStats(a, cx);
      cx.notify();
    });
    // Token use per Claude session: { at, pending, found, tok, cost }.
    this.stats = new Map();
    this.outside = [];
    this.scanOutside(cx);
    cx.timer.every(OUTSIDE_MS, (cx) => this.scanOutside(cx));
    // Tabs seen holding a terminal, and chat-only tabs by when they were first seen so.
    this.hadTerminal = new Set();
    this.orphans = new Map();
    cx.timer.every(2000, () => this.tidy());
    // Chat-first (setup.json chat.default): new Claude agents move into chat mode once.
    this.id = Math.random().toString(36).slice(2);
    this.started = Date.now();
    this.known = new Set(agents().map((a) => a.address));
    this.chatDefault ??= true;
    cx.timer.every(10000, (cx) => cx.spawn(async () => { this.chatDefault = (await setup()).chat?.default !== false; }));
    cx.timer.every(200, (cx) => this.chatFirst(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "clear-finished") this.clearFinished();
        cx.notify();
      }
    });
  }

  // Ends an agent and closes its tab, chat view included; with other terminals in the tab, or
  // when it's the space's last tab, only its pane goes (or the terminal, for one without a pane).
  dismiss(a) {
    const space = spaces().find((sp) => sp.tabs.some((tb) => tb.id === a.tab));
    const others = panes().filter((p) => p.tab === a.tab && p.pane !== a.pane && !p.mod);
    // Chat mode: closing its terminal's tab ends it, and its chat tab goes too.
    if (modes()[a.address]?.chatTab && closeWith(a.address)) return;
    closeWith(a.address);
    if (!others.length && (space?.tabs.length ?? 0) > 1) run("tab.close", { id: a.tab, confirmed: true });
    else if (a.pane && others.length) run("pane.close", { pane: a.pane });
    else run("terminal.kill", { terminal: a.address });
  }

  // Done and resting agents in the shown space; pinned ones stay.
  finished() {
    const space = spaces().find((sp) => sp.active);
    return agents().filter((a) => a.space === space?.id && resting(a) && !a.pinned);
  }

  askClearFinished() {
    const list = this.finished();
    if (!list.length) return;
    this.pendingClear = list.map((a) => a.address);
    openOverlay({
      mod: "confirm", kind: "dialog", width: 400, height: 190,
      props: {
        title: `Clear ${list.length} finished agent${list.length === 1 ? "" : "s"}?`,
        detail: `Ends ${list.map((a) => nickname(a)).join(", ")} and closes their tabs. Working agents and ones that need you stay.`,
        command: { name: "field.clear-finished" },
      },
    });
  }

  // The agents confirmed, unless one has started working again since.
  clearFinished() {
    const ok = new Set(this.pendingClear ?? []);
    this.pendingClear = null;
    for (const a of agents().filter((x) => ok.has(x.address) && resting(x))) this.dismiss(a);
  }

  // Moves new Claude agents into chat mode, and agents the CLI / Chat switch asked for.
  chatFirst(cx) {
    const asked = shared("pane-plus.convert") ?? {};
    for (const [term, req] of Object.entries(asked)) {
      // Another pond copy may be on screen too: the first to claim a request does it.
      if (!req.by) setShared("pane-plus.convert", { ...asked, [term]: { ...req, by: this.id } });
      else if (req.by === this.id) {
        const { [term]: _done, ...rest } = shared("pane-plus.convert") ?? {};
        setShared("pane-plus.convert", rest);
        convert(term, req.show, cx);
      } else if (Date.now() - req.at > 5000) {
        const { [term]: _stale, ...rest } = shared("pane-plus.convert") ?? {};
        setShared("pane-plus.convert", rest);
      }
      return;
    }
    const early = Date.now() - this.started < SETTLE_MS;
    for (const a of agents()) {
      if (this.known.has(a.address)) continue;
      if (early) { this.known.add(a.address); continue; }
      if (a.app === "codex") { this.known.add(a.address); continue; }
      const t = terminals().find((x) => x.address === a.address);
      if (a.app !== "claude-code" || !t?.records?.session || !a.pane || t.parent) continue;
      this.known.add(a.address);
      if (this.chatDefault && !modes()[a.address]) setShared("pane-plus.convert", { ...asked, [a.address]: { at: Date.now(), show: false } });
    }
  }

  // Closes tabs left holding only chat views whose terminal has gone, and puts a chat-mode agent's
  // terminal tab away again once Herdr brought it back for attention.
  tidy() {
    const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
    const shownTab = focused()?.tab;
    const tabs = spaces().flatMap((sp) => sp.tabs);
    for (const [term, m] of Object.entries(modes())) {
      if (!m.chatTab) continue;
      // Its terminal has ended: the chat view and its tab go too (a hidden chat copy doesn't check).
      if (!live.has(term)) {
        closeWith(term);
        continue;
      }
      const cli = tabs.find((tb) => tb.id === m.cliTab);
      // Its chat view was closed: the terminal's tab comes back to the lists.
      if (!panes().some((p) => p.pane === m.chatPane)) {
        if (cli?.settled) run("tab.unsettle", { id: m.cliTab });
        const { [term]: _gone, ...rest } = modes();
        setShared("pane-plus.chat", rest);
      } else if (!m.cli && cli && !cli.settled && shownTab !== cli.id && agents().find((x) => x.address === term)?.status !== "blocked") {
        run("tab.settle", { id: cli.id });
      }
    }
    const liveChats = new Set(Object.entries(modes()).filter(([term]) => live.has(term)).map(([, m]) => m.chatPane ?? m.chat));
    const dead = Object.entries(modes()).filter(([term]) => !live.has(term));
    const byTab = new Map();
    for (const p of panes()) byTab.set(p.tab, [...(byTab.get(p.tab) ?? []), p]);
    const now = Date.now();
    for (const [tab, ps] of byTab) {
      if (ps.some((p) => p.terminal || liveChats.has(p.pane))) {
        this.hadTerminal.add(tab);
        this.orphans.delete(tab);
        continue;
      }
      const chats = ps.every((p) => p.mod === "chat");
      const mine = dead.filter(([, m]) => ps.some((p) => p.pane === m.chat));
      if (!chats || (!this.hadTerminal.has(tab) && !mine.length)) continue;
      if (!this.orphans.has(tab)) this.orphans.set(tab, now);
      if (now - this.orphans.get(tab) < ORPHAN_MS) continue;
      const space = spaces().find((sp) => sp.tabs.some((tb) => tb.id === tab));
      if ((space?.tabs.length ?? 0) < 2) continue;
      this.orphans.delete(tab);
      for (const [term] of mine) closeWith(term);
      run("tab.close", { id: tab, confirmed: true });
    }
    for (const tab of this.orphans.keys()) if (!byTab.has(tab)) this.orphans.delete(tab);
  }

  // Token use for an agent's Claude session, at most every STATS_MS.
  loadStats(a, cx) {
    const sid = terminals().find((x) => x.address === a.address)?.records?.session?.app;
    if (!sid) return;
    const c = this.stats.get(sid);
    if (c && (c.pending || Date.now() - c.at < STATS_MS)) return;
    this.stats.set(sid, { ...c, pending: true });
    cx.spawn(async (cx) => {
      const r = await exec("python3", ["-I", "-c", STATS_PY, dashed(sid), JSON.stringify(PRICES)]).catch(() => null);
      let v = {};
      try { v = JSON.parse(r?.stdout || "{}"); } catch {}
      this.stats.set(sid, { ...v, at: Date.now(), pending: false });
      cx.notify();
    });
  }

  usage(a) {
    const sid = terminals().find((x) => x.address === a.address)?.records?.session?.app;
    const c = sid && this.stats.get(sid);
    if (!c) return "—";
    if (!c.found) return c.pending ? "…" : "—";
    return `${tokens(c.tok)} tok · ~$${c.cost.toFixed(2)} est.`;
  }

  scanOutside(cx) {
    if (this.scanning) return;
    this.scanning = true;
    const ids = terminals().map((k) => k.records?.session?.app).filter(Boolean);
    cx.spawn(async (cx) => {
      const r = await exec("python3", ["-I", "-c", OUTSIDE_PY, ids.join(","), String(OUTSIDE_MAX)]).catch(() => null);
      try { this.outside = JSON.parse(r?.stdout || "[]"); } catch {}
      this.scanning = false;
      cx.notify();
    });
  }

  // An agent's sub-agents: Claude's own (records its hooks report) and terminals it started with hc.
  // A baby that was already finished before the pond saw it working is skipped.
  babies(a) {
    const all = terminals();
    const recs = all.find((x) => x.address === a.address)?.records ?? {};
    const found = [
      ...Object.entries(recs).filter(([id]) => !id.includes(".") && id !== "tool" && id !== "session").map(([id, r]) => ({
        key: `${a.address}/${id}`, type: r.app ?? "agent", codex: isCodex(r.app), done: r.state === "done",
        task: prose(recs[`${id}.d`]?.app), act: activityOf(recs[`${id}.t`]),
      })),
      ...all.filter((k) => k.parent === a.address).map((k) => ({
        key: k.address, address: k.address, type: k.report?.app ?? k.program?.name ?? "agent",
        codex: isCodex(k.report?.app ?? k.program?.key), done: k.state !== "live" || k.status === "done",
        task: k.title || null, act: activityOf(k.records?.tool),
      })),
    ];
    const now = Date.now();
    const out = [];
    for (const b of found) {
      if (!b.done) {
        this.seen.add(b.key);
        out.push({ ...b, leaving: false });
        continue;
      }
      if (!this.seen.has(b.key) && !this.leaving.has(b.key)) continue;
      if (!this.leaving.has(b.key)) this.leaving.set(b.key, now);
      this.seen.delete(b.key);
      if (now - this.leaving.get(b.key) < LEAVE_MS) out.push({ ...b, leaving: true });
      else this.leaving.delete(b.key);
    }
    return out;
  }

  // A baby trails its parent in two staggered rows, wearing a badge for what it's doing; once done
  // it grows and swims up out of frame.
  baby(t, s, b, i) {
    const h = hash(b.key);
    const size = b.leaving ? BABY * 2 : BABY;
    const art = image(`${ART}/${b.codex ? "diver-baby" : "baby"}.svg`)
      .w(size).h(b.codex ? size : size * 12 / 14)
      .transition("width", { duration: 900, easing: "ease-out" })
      .transition("height", { duration: 900, easing: "ease-out" });
    const hovered = this.hoveredBaby === b.key;
    return div().id(`baby-${b.key}`).absolute()
      .left(this.babySpot(i).left)
      .top(b.leaving ? -this.scene.h - 80 : this.babySpot(i).top)
      .transition("top", { duration: LEAVE_MS - 400, delay: 500, easing: "ease-in" })
      .on_hover((over, cx) => {
        if (over) this.hoveredBaby = b.key;
        else if (hovered) this.hoveredBaby = null;
        cx.notify();
      })
      .when(Boolean(b.address), (el) => el.on_click((_e, cx) => { cx.stop_propagation(); focusAgent(b.address); }))
      .child(div().relative()
        .when(!b.leaving, (el) => el.loop("top", { from: 0, to: b.act ? -2 : -4, period: (b.act ? 1400 : 700) + (h % 400) }))
        // Babies that aren't saying what they do paddle in place.
        .when(!b.leaving && !b.act, (el) => el.loop("left", { from: -2, to: 2, period: 900 + (h % 300) }))
        .child(art)
        .when(Boolean(b.act) && !b.leaving, (el) => el.child(this.badge(t, s, b.act, h)))
        .when(b.leaving, (el) => el.child(div().absolute().top(-12).left(size - 4).text_size(12).text_color("#ffd166")
          .loop("opacity", { from: 0.2, to: 1, period: 400 }).child("✦"))));
  }

  // Where baby i sits, from its parent's body.
  babySpot(i) {
    const row = i % 2;
    return { left: -BABY_GAP * (Math.floor(i / 2) + 1) - row * BABY_GAP / 2, top: 4 + row * 20 };
  }

  // What a hovered baby is up to: its task, its kind and what it's doing. Drawn by its parent,
  // over the parent's label and the other babies, and kept inside the pond.
  babyCard(t, s, b, x, left, top) {
    const W = 170;
    return v_flex().absolute().top(top).w(W).items_center()
      .left(Math.min(Math.max(left - W / 2, 4 - x), this.scene.w - x - W - 4))
      .child(v_flex().px(7).py(3).rounded(rad(this.st, 7)).bg(s.card).border(1).border_color(`${t.working}66`).max_w(W)
        .child(div().text_size(10).font_semibold().text_color(s.labelInk).child(b.task ?? "No task given"))
        .child(div().text_size(9).text_color(s.muted)
          .child([kind(b.type) + (b.codex && !isCodex(b.type) ? " (Codex)" : ""), doing(b.act)].filter(Boolean).join(" · "))));
  }

  // A baby's activity as a tiny chip above its head: the parent's props, shrunk.
  badge(t, s, act, h) {
    const chip = (child) => div().absolute().top(-12).left(BABY / 2 - 7).w(14).h(11).rounded(this.st.name === "deck" ? 1 : 4).bg(s.label)
      .flex().items_center().justify_center().child(child);
    const glyph = (frames, ms) => div().text_size(8).font_semibold().text_color(s.labelInk).frames(frames, ms);
    switch (act.kind) {
      case "think": return chip(glyph(["·", "··", "···"], 420));
      case "delegate": return chip(glyph(["↳", "↳·"], 420));
      case "read": return chip(div().relative().w(12).h(9)
        .child(image(`${ART}/magnifier.svg`).absolute().top(0).w(9).h(9).loop("left", { from: 0, to: 3, period: 1400 + (h % 300) })));
      case "edit": return chip(image(`${ART}/hammer.svg`).w(9).h(9).loop("opacity", { from: 0.5, to: 1, period: 380 }));
      case "run": return chip(image(`${ART}/screen.svg`).w(11).h(9));
      case "web": return chip(svg(`${ART}/globe.svg`).size(8).text_color(t.accent).spin(2200));
      default: return chip(glyph(["•", "·"], 600));
    }
  }

  // Hovered critters, and the parent of a hovered baby, draw over their neighbours.
  onTop(a) {
    const baby = this.hoveredBaby ?? "";
    return a.address === this.hovered || baby.startsWith(`${a.address}/`)
      || terminals().some((k) => k.address === baby && k.parent === a.address);
  }

  color(t, status, s) {
    return { working: t.working, blocked: t.blocked, done: t.done }[status] ?? s.dim;
  }

  // What a working agent is doing, from its tool record; null when it isn't saying.
  activity(a) {
    if (a.status !== "working") return null;
    return activityOf(terminals().find((x) => x.address === a.address)?.records?.tool);
  }

  // When its tab entered its current state: working since, else last change.
  since(a) {
    const tab = spaces().flatMap((sp) => sp.tabs).find((tb) => tb.id === a.tab);
    return since(a.status === "working" ? tab?.working_since : tab?.changed_at);
  }

  // Where an agent sits: its own slot across the pond, at a depth by state.
  place(a, slot, slotW, groundY) {
    const h = hash(a.address);
    const x = slot * slotW + 20;
    const width = Math.max(slotW - 6, 70);
    // Neighbouring workers use different depths so their labels don't collide.
    const y = a.status === "working" ? this.scene.h * (slot % 2 ? 0.47 : 0.25) + (h % 3) * 5
      : a.status === "blocked" ? 72
      : groundY - CRITTER + 6;
    return { x, y, width };
  }

  // Two small lines: the name, then what it's doing (or its state) and for how long.
  label(t, s, a, act, width, kids) {
    const c = this.color(t, a.status, s);
    const what = doing(act) ?? WORD[a.status] ?? a.status;
    const st = this.st;
    if (st.name === "deck") {
      // A mono chip: amber name, a letter badge for the state, a status-coloured edge.
      return v_flex().px(5).py(2).gap(1).rounded(1).bg(s.label).border_l(2).border_color(c).max_w(width).min_w(0)
        .child(div().max_w(width - 12).truncate().text_size(9.5).font_bold().text_color(s.labelInk)
          .child(caps(st, nickname(a, (width - 12) * 5.3 / 6.4))))
        .child(h_flex().gap(4).items_center()
          .child(letterBadge(st, t, LETTER[a.status] ?? "?", c))
          .child(div().text_size(9).text_color(s.muted).child(caps(st, [what, this.since(a), kids ? `+${kids} sub` : ""].filter(Boolean).join(" · ")))));
    }
    if (st.name === "lcars") {
      return v_flex().items_center().gap(2).max_w(width).min_w(0)
        .child(div().max_w(width - 4).truncate().h(16).px(8).rounded(8).bg(a.status === "idle" ? t.ansi5 : c)
          .font_family(st.head).text_size(13).text_color(t.background).child(caps(st, nickname(a, (width - 16) * 5.3 / 4.6))))
        .child(div().font_family(st.head).text_size(11).text_color(c === s.dim ? s.muted : c)
          .child(caps(st, [what, this.since(a), kids ? `+${kids} sub` : ""].filter(Boolean).join(" · "))));
    }
    return v_flex().items_center().px(6).py(1).rounded(6).bg(s.label).max_w(width).min_w(0)
      .child(div().max_w(width - 12).truncate().text_size(10).font_semibold().text_color(s.labelInk).child(nickname(a, width - 12)))
      .child(h_flex().gap(4).items_center()
        .child(div().size(5).rounded(3).bg(c))
        .child(div().text_size(9).text_color(s.muted).child([what, this.since(a), kids ? `↳${kids}` : ""].filter(Boolean).join(" · "))));
  }

  // A card stays a moment after the pointer leaves its critter, so it can be reached.
  unhover(cx) {
    cx.timer.after(250, (cx) => {
      if (this.overCritter || this.overCard) return;
      this.hovered = null;
      cx.notify();
    });
  }

  // The hover card: everything about one agent, kept inside the pond.
  card(t, s, a, slot, slotW, groundY) {
    const { x, y, width } = this.place(a, slot, slotW, groundY);
    const act = this.activity(a);
    const c = this.color(t, a.status, s);
    const kids = this.babies(a).filter((b) => !b.leaving);
    // Beside the critter (right when there's room), and clamped to fit vertically.
    const W = 270;
    const done = resting(a);
    const H = 200 + (done ? 26 : 0) + (kids.length ? 20 + 16 * Math.min(kids.length, MAX_BABIES) : 0);
    const right = x + width + W + 8 < this.scene.w;
    const left = right ? x + width / 2 + CRITTER / 2 + 6 : Math.max(x + width / 2 - CRITTER / 2 - W - 6, 8);
    const top = Math.min(Math.max(y - 30, 8), this.scene.h - H - 8);
    const st = this.st;
    const sharp = st.name !== "soft";
    const row = (k, v) => h_flex().gap(8).items_start()
      .child(div().w(62).flex_none().text_size(sharp ? 9.5 : 10.5).text_color(sharp ? s.dim : s.muted).child(caps(st, k)))
      .child(div().flex_1().min_w(0).text_size(10.5).text_color(s.labelInk).child(v));
    const branch = panes().find((p) => p.pane === a.pane)?.branch;
    return v_flex().id("card").absolute().left(left).w(W).p(10).gap(5).rounded(rad(st, 10)).bg(s.card).border(1)
      .border_color(st.name === "lcars" ? c : `${c}66`)
      .top(top)
      .when(st.name === "deck", (el) => el.children(brackets(t, c)))
      .on_hover((over, cx) => {
        this.overCard = over;
        if (!over) this.unhover(cx);
      })
      .child(h_flex().gap(6).items_center()
        .child(sharp ? letterBadge(st, t, LETTER[a.status] ?? "?", c) : div().size(7).rounded(4).bg(c))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(sharp ? t.accent : s.labelInk)
          .when(st.name === "lcars", (el) => el.font_family(st.head).text_size(16))
          .child(caps(st, nickname(a))))
        .child(div().text_size(10.5).text_color(c).child(caps(st, WORD[a.status] ?? a.status))))
      .child(div().text_size(11).text_color(s.labelInk).child(a.title || "No task yet"))
      .child(row("Doing", act ? `${doing(act)}${act.tool && act.tool !== "think" ? ` · ${act.tool}` : ""}` : WORD[a.status] ?? a.status))
      .child(row("For", this.since(a) || "—"))
      .child(row("Where", `${a.space_name} / ${a.tab_name} · ${a.address}`))
      .child(row("Branch", branch || "—"))
      .child(row("Used", this.usage(a)))
      .when(kids.length > 0, (el) => el
        .child(div().pt(3).text_size(10.5).text_color(s.muted).child(caps(st, `Sub-agents · ${kids.length}`)))
        .children(kids.slice(0, MAX_BABIES).map((b) => h_flex().gap(6).items_center()
          .child(div().size(5).flex_none().rounded(sharp ? 0 : 3).bg(b.act ? t.working : s.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(s.labelInk).child(b.task ?? kind(b.type)))
          .child(div().flex_none().text_size(10).text_color(s.muted)
            .child([kind(b.type) + (b.codex && !isCodex(b.type) ? " (Codex)" : ""), doing(b.act)].filter(Boolean).join(" · "))))))
      .child(h_flex().pt(2).items_center().gap(8)
        .child(div().flex_1().text_size(9.5).text_color(s.dim).child(caps(st, "Click to focus · right-click to chat")))
        .child(h_flex().id("changes").px(8).py(3).rounded(rad(st, 6)).border(1).border_color(s.dim)
          .cursor_pointer().hover((b) => b.bg(`${t.accent}22`))
          .on_click((_e, cx) => { cx.stop_propagation(); this.overCard = false; this.hovered = null; openChanges(a.address); })
          .child(div().text_size(10.5).font_semibold().text_color(s.labelInk).child(caps(st, "Changes"))))
        .when(done, (el) => el.child(h_flex().id("dismiss").px(8).py(3).rounded(rad(st, 6)).border(1).border_color(`${t.blocked}88`)
          .cursor_pointer().hover((b) => b.bg(`${t.blocked}22`))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.overCard = false;
            this.hovered = null;
            this.dismiss(a);
          })
          .child(div().text_size(10.5).font_semibold().text_color(t.blocked).child(caps(st, "Dismiss"))))));
  }

  bubbles(s, h, n) {
    return Array.from({ length: n }, (_, i) =>
      div().absolute().left(6 + i * 9).top(4).size(4 + (i % 2) * 2).rounded(4).bg(s.bubble)
        .loop("top", { from: 4, to: -34 - i * 6, period: 1500 + ((h >> i) % 700), easing: "ease-out" })
        .loop("opacity", { from: 0.9, to: 0, period: 1500 + ((h >> i) % 700), easing: "ease-out" }));
  }

  // The prop for an activity, beside the critter's right claw.
  prop(t, s, act, h) {
    const R = CRITTER - 2;
    switch (act.kind) {
      case "think":
      case "delegate":
        return div().absolute().top(-20).left(R - 4).px(5).rounded(this.st.name === "deck" ? 1 : 8).bg(s.label).text_size(11).font_semibold()
          .text_color(s.labelInk).frames(act.kind === "think" ? ["·", "··", "···"] : ["↳", "↳ ·", "↳ ··"], 420);
      case "read":
        return image(`${ART}/magnifier.svg`).absolute().top(-2).w(16).h(16)
          .loop("left", { from: R - 6, to: R + 10, period: 1600 + (h % 400) });
      case "edit":
        return div().absolute().top(-8).left(R - 2)
          .child(image(`${ART}/hammer.svg`).w(14).h(14).loop("top", { from: -6, to: 4, period: 380, easing: "ease-in" }))
          .child(div().absolute().top(10).left(-6).text_size(9).text_color("#ffd166")
            .loop("opacity", { from: 0, to: 1, period: 380 }).child("✦"));
      case "run":
        return div().absolute().top(4).left(R)
          .child(image(`${ART}/screen.svg`).w(24).h(20))
          .child(div().absolute().top(9).left(17).w(3).h(2).bg("#7CF2C8").loop("opacity", { from: 0, to: 1, period: 700 }));
      case "web":
        return svg(`${ART}/globe.svg`).absolute().top(-6).left(R).size(15).text_color(t.accent).spin(2200);
      default:
        return null;
    }
  }

  critter(t, s, a, slot, slotW, groundY) {
    const h = hash(a.address);
    const codex = isCodex(a.app) || a.program?.key === "codex";
    const kids = this.babies(a);
    const st = a.status;
    const act = this.activity(a);
    // Agents that say what they're doing stay put and act it out; others swim laps.
    const swimming = st === "working" && (!act || act.kind === "tool");
    const asleep = st === "idle";
    const { x, y, width } = this.place(a, slot, slotW, groundY);
    const lane = Math.max(width - CRITTER - 24, 0);
    // The critter sits right of centre by half its brood, so parent and babies stay in its slot.
    const shown = Math.min(kids.length, MAX_BABIES);
    const brood = shown ? Math.ceil(shown / 2) * BABY_GAP + (shown > 1 ? BABY_GAP / 2 : 0) : 0;
    const rest = lane / 2 + Math.min(brood / 2, lane / 2);

    const body = v_flex().items_center().relative()
      .when(swimming, (el) => el.loop("top", { from: 0, to: -6, period: 1300 + (h % 500) }))
      .when(Boolean(act) && !swimming, (el) => el.loop("top", { from: 0, to: act.kind === "edit" ? -2 : -3, period: act.kind === "edit" ? 380 : 1800 }))
      .when(st === "blocked", (el) => el.loop("top", { from: 0, to: -10, period: 560, easing: "ease-out" }))
      .when(st === "done", (el) => el.loop("top", { from: 0, to: -2, period: 2400 }))
      .child(codex
        ? image(`${ART}/diver.svg`).w(CRITTER * 0.8).h(CRITTER * 0.8 * 24 / 22)
        : image(`${ART}/${asleep ? "critter-sleep" : "critter"}.svg`).w(CRITTER).h(CRITTER * 16 / 22))
      .children(kids.slice(0, MAX_BABIES).map((b, i) => this.baby(t, s, b, i)))
      .when(Boolean(act) && !swimming, (el) => el.children([this.prop(t, s, act, h)].filter(Boolean)))
      .when(swimming, (el) => el.children(this.bubbles(s, h, 3)))
      .when(st === "blocked", (el) => el.child(
        div().absolute().top(-22).left(CRITTER / 2 - 9).size(18).rounded(9).bg(t.blocked)
          .flex().items_center().justify_center().text_size(12).font_semibold().text_color("#ffffff")
          .loop("opacity", { from: 0.45, to: 1, period: 700 }).child("!")))
      .when(st === "done", (el) => el.child(
        div().absolute().top(-14).left(CRITTER - 6).text_size(14).text_color("#ffd166")
          .loop("opacity", { from: 0.2, to: 1, period: 900 }).child("✦")))
      .when(asleep, (el) => el.child(
        div().absolute().top(-16).left(CRITTER - 4).text_size(11).font_semibold().text_color(s.muted)
          .frames(["z", "z z", "z z z", ""], 650)));

    return v_flex().id(`critter-${a.address}`).absolute().top(y).left(x).w(width).items_center().gap(3).cursor_pointer()
      .transition("top", { duration: 900, easing: "ease-in-out" })
      .on_hover((over, cx) => {
        if (over) {
          this.hovered = this.overCritter = a.address;
          this.loadStats(a, cx);
          return cx.notify();
        }
        if (this.overCritter !== a.address) return;
        this.overCritter = null;
        this.unhover(cx);
      })
      .on_click(() => focusAgent(a.address))
      // The agent's chat view, in place of its terminal (the pane header's Chat switch).
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        toChat(a.address);
      })
      .child(div().relative().w(width).h(CRITTER * 0.8)
        .child(div().absolute().top(0)
          .when(swimming, (el) => el.loop("left", { from: Math.min(brood, lane), to: lane, period: 4200 + (h % 2400) }))
          .when(!swimming, (el) => el.left(rest))
          .child(body)))
      .child(this.label(t, s, a, act, width, kids.filter((b) => !b.leaving).length))
      .children(kids.slice(0, MAX_BABIES).flatMap((b, i) => {
        if (b.key !== this.hoveredBaby || b.leaving) return [];
        const spot = this.babySpot(i);
        return [this.babyCard(t, s, b, x, (swimming ? lane / 2 : rest) + spot.left + BABY / 2, spot.top + BABY)];
      }));
  }

  scenery(s, w, h, groundY) {
    const st = this.st;
    if (st.name === "deck") return this.sonar(s, w, h, groundY);
    if (st.name === "lcars") return this.viewscreen(s, w, h, groundY);
    const bands = s.water.map((c, i) =>
      div().absolute().left(0).w(w).top((groundY / s.water.length) * i).h(groundY / s.water.length + 1).bg(c));
    const glints = [0.12, 0.42, 0.71].map((f, i) =>
      div().absolute().top(10 + i * 4).h(2).w(70).rounded(1).bg(s.glint)
        .loop("left", { from: w * f, to: w * f + 40, period: 6000 + i * 1500 })
        .loop("opacity", { from: 0.3, to: 1, period: 3000 + i * 700 }));
    const weeds = [0.06, 0.33, 0.58, 0.9].map((f, i) =>
      image(`${ART}/seaweed.svg`).absolute().w(22).h(54 + (i % 2) * 16).top(groundY - 50 - (i % 2) * 16)
        .loop("left", { from: w * f, to: w * f + 3, period: 2600 + i * 400 }));
    const rocks = [0.2, 0.75].map((f) => image(`${ART}/rock.svg`).absolute().left(w * f).top(groundY - 10).w(40).h(18));
    const ambient = [0.15, 0.5, 0.82].map((f, i) =>
      div().absolute().left(w * f).size(5).rounded(3).bg(s.bubble)
        .loop("top", { from: groundY - 20, to: 30, period: 7000 + i * 1900, easing: "linear" })
        .loop("opacity", { from: 0.7, to: 0, period: 7000 + i * 1900, easing: "linear" }));
    return [
      ...bands,
      div().absolute().left(0).w(w).top(groundY).h(h - groundY).bg(s.sand),
      div().absolute().left(0).w(w).top(groundY).h(3).bg(s.sandEdge),
      ...glints, ...weeds, ...rocks, ...ambient,
    ];
  }

  // Weeds, rocks and rising bubbles, dimmed for the night scenes.
  furniture(s, w, groundY, dim) {
    const weeds = [0.06, 0.33, 0.58, 0.9].map((f, i) =>
      image(`${ART}/seaweed.svg`).absolute().w(22).h(54 + (i % 2) * 16).top(groundY - 50 - (i % 2) * 16).opacity(dim)
        .loop("left", { from: w * f, to: w * f + 3, period: 2600 + i * 400 }));
    const rocks = [0.2, 0.75].map((f) => image(`${ART}/rock.svg`).absolute().left(w * f).top(groundY - 10).w(40).h(18).opacity(dim));
    const ambient = [0.15, 0.5, 0.82].map((f, i) =>
      div().absolute().left(w * f).size(4).rounded(this.st.name === "deck" ? 0 : 3).bg(s.bubble)
        .loop("top", { from: groundY - 20, to: 30, period: 7000 + i * 1900, easing: "linear" })
        .loop("opacity", { from: 0.7, to: 0, period: 7000 + i * 1900, easing: "linear" }));
    return [...weeds, ...rocks, ...ambient];
  }

  // Deck: a sonar tank at night. Near-black bands under a faint grid, a teal sweep crossing it,
  // and a ruler of ticks along the floor.
  sonar(s, w, h, groundY) {
    const t = theme();
    const bands = s.water.map((c, i) =>
      div().absolute().left(0).w(w).top((groundY / s.water.length) * i).h(groundY / s.water.length + 1).bg(c));
    const cols = Array.from({ length: Math.ceil(w / 48) }, (_, i) => div().absolute().top(0).left(i * 48).w(1).h(groundY).bg(s.grid));
    const rows = Array.from({ length: Math.ceil(groundY / 32) }, (_, i) => div().absolute().left(0).top(i * 32).w(w).h(1).bg(s.grid));
    const ticks = Array.from({ length: Math.ceil(w / 12) }, (_, i) =>
      div().absolute().left(i * 12).top(groundY + 1).w(1).h(i % 4 ? 3 : 7).bg(i % 4 ? s.sandEdge : `${t.accent}66`));
    const sweep = div().absolute().top(0).w(90).h(groundY).flex().justify_end()
      .loop("left", { from: -90, to: w, period: 9000, easing: "linear" })
      .child(div().w(30).h_full().bg(`${s.sweep}08`)).child(div().w(1).h_full().bg(`${s.sweep}55`));
    return [
      ...bands, ...cols, ...rows, sweep,
      div().absolute().left(0).w(w).top(groundY).h(h - groundY).bg(s.sand),
      div().absolute().left(0).w(w).top(groundY).h(1).bg(`${t.accent}55`),
      ...ticks,
      ...this.furniture(s, w, groundY, 0.45),
    ];
  }

  // LCARS: a black viewscreen with an elbow down the left and a run of coloured bars for a floor.
  viewscreen(s, w, h, groundY) {
    const t = theme();
    const bands = s.water.map((c, i) =>
      div().absolute().left(0).w(w).top((groundY / s.water.length) * i).h(groundY / s.water.length + 1).bg(c));
    const stars = Array.from({ length: 18 }, (_, i) => {
      const k = hash(`star${i}`);
      return div().absolute().left((k % 1000) / 1000 * w).top(40 + (k >> 10) % Math.max(groundY - 60, 1)).size(1 + (i % 2))
        .bg(i % 3 ? "#f2e3c655" : "#9999ff88").loop("opacity", { from: 0.2, to: 1, period: 2400 + (k % 2000) });
    });
    const cols = [t.ansi3, t.accent, t.ansi5, t.ansi4, t.accent, t.ansi11, t.ansi5];
    const weights = [3, 7, 2, 5, 1, 4, 2];
    const total = weights.reduce((a, b) => a + b, 0);
    const floorW = w - 38 - 4 * cols.length;
    let x = 32;
    const floor = cols.map((c, i) => {
      const bw = (floorW * weights[i]) / total;
      const el = div().absolute().left(x).top(groundY + 8).w(bw).h(10).bg(c)
        .when(i === cols.length - 1, (el) => el.rounded_r(5));
      x += bw + 4;
      return el;
    });
    return [
      ...bands, ...stars,
      div().absolute().left(0).w(w).top(groundY).h(h - groundY).bg(s.sand),
      // The elbow: down from the header bar, round the corner, along the floor.
      div().absolute().left(6).top(24).w(10).h(groundY - 16).bg(t.accent),
      div().absolute().left(6).top(groundY + 8).w(22).h(10).bg(t.accent).rounded_bl(8),
      ...floor,
      ...this.furniture(s, w, groundY, 0.55),
    ];
  }

  // Sessions running outside Herdr (the Claude app, another terminal, Codex), read-only: each a
  // translucent critter in a lane on the right. Click opens its chat in a window.
  lane() {
    const top = 46;
    const rowH = Math.min(40, (this.scene.h - SAND - top - 20) / Math.max(this.outside.length, 1));
    return { x: this.scene.w - LANE_W - 6, top, rowH, rowTop: (i) => top + 16 + i * rowH };
  }

  where(o) {
    return o.kind === "codex" ? "Codex" : o.app === "claude-desktop" ? "Claude app" : o.app === "cli" ? "Claude Code" : "Claude";
  }

  elsewhere(t, s, groundY) {
    const L = this.lane();
    const now = Date.now();
    return [
      this.st.name === "soft"
        ? div().absolute().left(L.x).top(L.top - 4).w(LANE_W).h(groundY - L.top - 2).rounded(10).bg(s.label).opacity(0.35)
        : div().absolute().left(L.x).top(L.top - 4).w(LANE_W).h(groundY - L.top - 2).rounded(rad(this.st, 10)).bg(`${s.label}`)
          .border(1).border_color(this.st.name === "lcars" ? `${t.ansi4}88` : s.sandEdge).border_dashed(),
      this.st.name === "soft"
        ? div().absolute().left(L.x + 8).top(L.top).text_size(9.5).font_semibold().text_color(s.muted).child("Elsewhere")
        : h_flex().absolute().left(L.x + 8).top(L.top).gap(5).items_center()
          .child(div().text_size(this.st.name === "lcars" ? 12 : 9).font_bold().when(this.st.name === "lcars", (el) => el.font_family(this.st.head))
            .text_color(this.st.name === "lcars" ? t.ansi4 : t.done).child("ELSEWHERE"))
          .child(div().text_size(8.5).text_color(s.dim).child("// EXT")),
      ...this.outside.map((o, i) => {
        const working = now - o.at * 1000 < 30000;
        const codex = o.kind === "codex";
        const art = codex
          ? image(`${ART}/diver.svg`).w(20).h(20 * 24 / 22)
          : image(`${ART}/${working ? "critter" : "critter-sleep"}.svg`).w(26).h(26 * 16 / 22);
        return h_flex().id(`out-${o.id}`).absolute().left(L.x + 6).top(L.rowTop(i)).w(LANE_W - 12).gap(6).items_center()
          .cursor_pointer().opacity(this.hoveredOut === o.id ? 0.95 : 0.6)
          .on_hover((over, cx) => {
            if (over) this.hoveredOut = o.id;
            else if (this.hoveredOut === o.id) this.hoveredOut = null;
            cx.notify();
          })
          .on_click(() => openOverlay({ mod: "chat", kind: "window", width: 560, height: 0.8,
            props: { transcript: o.path, title: o.title || nickname({ title: o.title, address: o.id }) } }))
          .child(div().relative().w(26).h(22).child(div().absolute().top(0)
            .when(working, (el) => el.loop("top", { from: 0, to: -3, period: 1300 + (hash(o.id) % 500) }))
            .child(art)))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(this.st.name === "soft" ? 10 : 9.5).font_semibold().text_color(s.labelInk)
              .child(caps(this.st, nickname({ title: o.title, address: o.id }, this.st.name === "soft" ? LANE_W - 50 : (LANE_W - 50) * 5.3 / 6.4))))
            .child(div().truncate().text_size(9).text_color(s.muted).child(caps(this.st, [working ? "working" : "idle", since(o.at * 1000)].filter(Boolean).join(" · ")))));
      }),
    ];
  }

  outsideCard(t, s, o, i) {
    const L = this.lane();
    const W = 240;
    const row = (k, v) => h_flex().gap(8).items_start()
      .child(div().w(46).flex_none().text_size(this.st.name === "soft" ? 10.5 : 9.5).text_color(s.muted).child(caps(this.st, k)))
      .child(div().flex_1().min_w(0).text_size(10.5).text_color(s.labelInk).child(v));
    return v_flex().absolute().left(L.x - W - 6).top(Math.min(Math.max(L.rowTop(i) - 20, 8), this.scene.h - 140)).w(W)
      .p(10).gap(5).rounded(rad(this.st, 10)).bg(s.card).border(1).border_color(`${s.dim}66`)
      .when(this.st.name === "deck", (el) => el.children(brackets(t, t.done)))
      .child(div().text_size(12).font_semibold().text_color(this.st.name === "soft" ? s.labelInk : t.accent)
        .child(caps(this.st, nickname({ title: o.title, address: o.id }))))
      .child(div().text_size(11).text_color(s.labelInk).child(o.title || "No task yet"))
      .child(row("Runs in", this.where(o)))
      .child(row("Folder", (o.cwd || "—").replace(home(), "~")))
      .child(row("Active", `${since(o.at * 1000) || "<1m"} ago`))
      .child(div().pt(2).text_size(9.5).text_color(s.dim).child(caps(this.st, "Outside Herdr, read-only · click to open its chat")));
  }

  // Deck and LCARS: "POND // 01.FLD", the count, state badges with counts, then the buttons.
  header(t, s, w, list, stats, finished, space) {
    const st = this.st;
    const lcars = st.name === "lcars";
    const button = (id, text, primary, onClick) => h_flex().id(id).h(lcars ? 20 : 20).px(lcars ? 11 : 9).items_center()
      .rounded(lcars ? 10 : 1).cursor_pointer()
      .when(primary, (el) => el.bg(s.button))
      .when(!primary && lcars, (el) => el.bg(t.ansi5))
      .when(!primary && !lcars, (el) => el.bg(s.label).border(1).border_color(t.border))
      .hover((el) => el.opacity(0.85))
      .on_click(onClick)
      .child(div().when(lcars, (el) => el.font_family(st.head).text_size(14)).when(!lcars, (el) => el.text_size(10).font_bold())
        .text_color(primary || lcars ? s.buttonInk : s.labelInk).child(caps(st, text)));
    return h_flex().absolute().left(0).top(0).w(w).pl(lcars ? 6 : 14).pr(lcars ? 10 : 14).pt(lcars ? 12 : 10).items_center().gap(lcars ? 6 : 10)
      .child(lcars ? heading(st, t, "Pond", `${String(list.length).padStart(2, "0")} agents`)
        : h_flex().gap(10).items_center()
          .child(heading(st, t, "Pond", "01.fld"))
          .child(div().text_size(9.5).text_color(s.muted).child(`${String(list.length).padStart(2, "0")} AGENTS`)))
      .when(!lcars, (el) => el.child(div().flex_1()))
      .children(stats.map(([n, word, c]) => h_flex().gap(4).items_center().px(lcars ? 0 : 5).h(20)
        .when(!lcars, (el) => el.bg(s.label).border(1).border_color(`${c}55`))
        .child(letterBadge(st, t, lcars ? `${n} ${word}` : { "need you": "B", resting: "I" }[word] ?? word[0].toUpperCase(), c))
        .when(!lcars, (el) => el.child(div().text_size(10).text_color(s.labelInk).child(String(n).padStart(2, "0"))))))
      .when(finished.length > 0, (el) => el.child(button("clear-finished", `Clear finished · ${finished.length}`, false, () => this.askClearFinished())))
      .child(button("new-claude", "+ Claude", true, () => run("tab.new", { name: "claude", argv: ["claude"], space: space?.id })));
  }

  render() {
    const t = theme();
    this.st = style();
    const s = SCENES[this.st.name === "soft" ? (settings().dark ? "dark" : "light") : this.st.name];
    const list = agents();
    // The reported size is unzoomed; everything drawn here is scaled by the app's zoom.
    const zoom = Number(settings().zoom) || 1;
    const w = this.size.width / zoom;
    const h = this.size.height / zoom;
    this.scene = { w, h };
    const groundY = h - SAND;
    const laneW = this.outside.length ? LANE_W + 6 : 0;
    const slotW = list.length ? Math.min(220, (w - 40 - laneW) / list.length) : 0;
    const finished = this.finished();
    const count = (st) => list.filter((a) => a.status === st).length;
    const space = spaces().find((sp) => sp.active);
    const stats = [
      [count("working"), "working", t.working],
      [count("blocked"), "need you", t.blocked],
      [count("done"), "done", t.done],
      [count("idle"), "resting", s.dim],
    ].filter(([n]) => n > 0);

    const header = this.st.name !== "soft" ? this.header(t, s, w, list, stats, finished, space) : h_flex().absolute().left(0).top(0).w(w).px(18).pt(12).items_center().gap(12)
      .child(div().text_size(16).font_semibold().text_color(s.ink).child("The pond"))
      .child(div().text_size(12).text_color(s.muted).child(`${list.length} agent${list.length === 1 ? "" : "s"}`))
      .child(div().flex_1())
      .children(stats.map(([n, label, c]) =>
        h_flex().gap(5).items_center().px(9).py(3).rounded(10).bg(s.label)
          .child(div().size(6).rounded(3).bg(c))
          .child(div().text_size(11.5).text_color(s.labelInk).child(`${n} ${label}`))))
      .when(finished.length > 0, (el) => el.child(h_flex().id("clear-finished").px(10).py(4).rounded(8).bg(s.label)
        .border(1).border_color(`${s.dim}55`).cursor_pointer().hover((b) => b.opacity(0.85))
        .on_click(() => this.askClearFinished())
        .child(div().text_size(11.5).text_color(s.labelInk).child(`Clear finished · ${finished.length}`))))
      .child(h_flex().id("new-claude").px(11).py(5).rounded(8).bg(s.button).cursor_pointer()
        .hover((el) => el.opacity(0.85))
        .on_click(() => run("tab.new", { name: "claude", argv: ["claude"], space: space?.id }))
        .child(div().text_size(12).font_semibold().text_color(s.buttonInk).child("+ Claude")));

    const empty = list.length ? [] : [
      image(`${ART}/critter-sleep.svg`).absolute().left(w / 2 - CRITTER / 2).top(groundY - CRITTER + 10).w(CRITTER).h(CRITTER * 16 / 22),
      div().absolute().left(0).w(w).top(h * 0.42).flex().justify_center().text_size(12.5).text_color(s.muted)
        .child(caps(this.st, "The pond is quiet. Start an agent, or start one from the inbox.")),
    ];

    return div().id("pond").relative().size_full().overflow_hidden().rounded(rad(this.st, 12))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .children(this.scenery(s, w, h, groundY))
      .children(empty)
      .when(this.outside.length > 0, (el) => el.children(this.elsewhere(t, s, groundY)))
      .children(list.map((a, i) => [a, i])
        .sort(([a], [b]) => this.onTop(a) - this.onTop(b))
        .map(([a, i]) => this.critter(t, s, a, i, slotW, groundY)))
      .child(header)
      // A hovered baby shows its own card instead.
      .children(list.map((a, i) => [a, i]).filter(([a]) => a.address === this.hovered && !this.hoveredBaby)
        .map(([a, i]) => this.card(t, s, a, i, slotW, groundY)))
      .children(this.outside.map((o, i) => [o, i]).filter(([o]) => o.id === this.hoveredOut)
        .map(([o, i]) => this.outsideCard(t, s, o, i)));
  }
}
