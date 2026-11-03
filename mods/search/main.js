// Global search (keys.json "mod.open:search", ⌘⇧O): agents, tabs and spaces, PRs, Jira tickets, files and
// commands in one list. Type to filter (fuzzy), ↑/↓ and Enter to open, ⌘Enter opens a file in the editor,
// Tab jumps between groups; a leading >, @, #, ! or / searches one group only. Esc closes. Recent picks float up; an empty query shows them and the agents.
// PRs and tickets come from the inbox (shared "inbox.items") plus a live GitHub search.
// As a pane (props.file) it's a read-only viewer for the file picked here.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import { focusAgent } from "./mode.js";
import { agents, spaces, panes, focused, commands, layouts, exec, run, theme, settings, props, closeOverlay, openOverlay, shared, nextCommand, readTextFile, home } from "herdr";
import { style, label, rad, badge, heading, LETTER } from "./style.js";
import { setup } from "./setup.js";
import { words, match, matchPath } from "./fuzzy.js";

const GROUPS = [
  { id: "agents", title: "Agents", max: 8 },
  { id: "tabs", title: "Tabs & spaces", max: 6 },
  { id: "prs", title: "Pull requests", max: 10 },
  { id: "jira", title: "Jira tickets", max: 6 },
  { id: "files", title: "Files", max: 40 },
  { id: "commands", title: "Commands", max: 8 },
];
// A leading character narrows the search to one group: "> " commands, "@" agents, "#" PRs, "!" tickets, "/" files.
const PREFIX = { ">": "commands", "@": "agents", "#": "prs", "!": "jira", "/": "files" };

const ICON = { tabs: "layers", prs: "git-compare", jira: "square-pen", files: "file-text", commands: "terminal" };
const RECENT_MAX = 20;
const H = { head: 30, row: 34 };
const LIST_MAX = 1000;
const RUBYMINE = "/Applications/RubyMine.app";
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", rb: "ruby", erb: "html" };
// Folder -> its git root and tracked files, kept across opens; refreshed on each open.
const FILES = new Map();

const EXTRA = [
  { name: "Toggle pond", about: "Show or hide the pond", run: "layout.toggle", args: { id: "field" } },
  { name: "Toggle inbox", about: "Show or hide the inbox", run: "layout.toggle", args: { id: "inbox" } },
  { name: "Focus mode", about: "Hide everything but the panes", run: "pane-plus.zen" },
  ...["field", "deck", "lcars"].map((n) => ({ name: `Layout: ${n}`, about: `Switch to the ${n} layout`, run: "layout.switch", args: { name: n }, layout: n })),
  { name: "Herdr palette", about: "Herdr's own command palette", run: "app.palette" },
];

const PR_FIELDS = "number title url state isDraft headRefName author { login } repository { name nameWithOwner }";
const prItem = (p) => ({
  key: `${p.repository.name}#${p.number}`, number: p.number, title: p.title, url: p.url, repo: p.repository.nameWithOwner,
  branch: p.headRefName, preview: "pr-preview", meta: [p.state !== "OPEN" ? p.state.toLowerCase() : null, p.isDraft ? "draft" : null, p.author?.login].filter(Boolean).join(" · "),
});

// Where the person is: the focused pane's folder, else the focused block's, else the space's.
function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || home(), on };
}

// Field match: the title alone, else title and subtitle together (hits split back between them).
function fields(ws, title, sub = "") {
  const t = match(ws, title);
  if (t) return { score: t.score + 10, hits: t.hits, subHits: [] };
  const m = match(ws, `${title} ${sub}`);
  if (!m) return null;
  const n = title.length + 1;
  return { score: m.score, hits: m.hits.filter((i) => i < title.length), subHits: m.hits.filter((i) => i >= n).map((i) => i - n) };
}

function loadRecent() {
  try { return JSON.parse(localStorage.getItem("recent") ?? "[]"); } catch { return []; }
}

function openInEditor(file, line) {
  exec("test", ["-d", RUBYMINE]).then((r) => {
    if (r.code !== 0) return exec("open", [file]);
    // The launcher hands the file to the running RubyMine, at the line when there is one.
    return line ? exec(`${RUBYMINE}/Contents/MacOS/rubymine`, ["--line", String(line), file]) : exec("open", ["-a", "RubyMine", file]);
  }).catch(() => exec("open", [file]));
}

export default class Search extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    const p = props() ?? {};
    if (p.file) return this.initViewer(p, cx);
    this.q = "";
    this.at = 0;
    this.scroll = 0;
    this.recent = loadRecent();
    this.live = { q: null, items: [], loading: false };
    this.grep = { q: null, items: [], loading: false };
    this.token = 0;
    this.input = InputState.new({ placeholder: "Search agents, tabs, PRs, tickets, files, commands…" });
    this.input.on("change", (_e, cx) => this.changed(cx));
    this.input.on("submit", () => this.go(this.selected(), false));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.input.focus();
        else if (/^group[1-6]$/.test(c)) { this.jump(Number(c.slice(5)) - 1); this.auto = false; }
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      const cfg = await setup();
      this.repo = cfg.search?.repo ?? cfg.github.tabs.map((g) => g.query.match(/\brepo:(\S+)/)?.[1]).find(Boolean) ?? null;
      this.jiraSite = cfg.jira?.site ?? null;
    });
    this.loadFiles(cx);
  }

  // Tracked files of the repo you're in (git ls-files), else up to 20000 files under the folder.
  loadFiles(cx) {
    const { cwd, on } = location();
    this.folder = cwd;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        const root = top.code === 0 ? top.stdout.trim() : cwd;
        const r = top.code === 0
          ? await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, on })
          : await exec("sh", ["-c", "find . -type d \\( -name .git -o -name node_modules \\) -prune -o -type f -print0 | head -c 2000000"], { cwd: root, on });
        const paths = r.stdout.split("\0").filter(Boolean).map((s) => s.replace(/^\.\//, "")).slice(0, 60000);
        FILES.set(cwd, { root, on, git: top.code === 0, paths, lower: paths.map((s) => s.toLowerCase()) });
        this.scan(cx);
      } catch {}
      cx.notify();
    });
  }

  changed(cx) {
    const raw = this.input.value();
    this.only = PREFIX[raw.trimStart()[0]] ?? null;
    this.q = this.only ? raw.trimStart().slice(1) : raw;
    this.at = 0;
    this.auto = true;
    this.scroll = 0;
    const q = this.q.trim();
    const token = ++this.token;
    const number = /^#?\d{2,}$/.test(q);
    this.scan(cx);
    if (number || q.length >= 3) {
      cx.timer.after(number ? 0 : 350, (cx) => {
        if (token !== this.token) return;
        this.searchPRs(q, cx);
        if (q.length >= 3) this.searchContent(q, cx);
      });
    }
    cx.notify();
  }

  searchPRs(q, cx) {
    this.live = { q, items: this.live.items, loading: true };
    cx.spawn(async (cx) => {
      let items = [];
      try {
        const n = q.match(/^#?(\d+)$/)?.[1];
        if (n && this.repo) {
          const [owner, name] = this.repo.split("/");
          const r = await exec("gh", ["api", "graphql", "-F", `num=${n}`, "-f", `o=${owner}`, "-f", `n=${name}`, "-f",
            `query=query($o: String!, $n: String!, $num: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $num) { ${PR_FIELDS} } } }`]);
          const pr = r.code === 0 ? JSON.parse(r.stdout).data?.repository?.pullRequest : null;
          if (pr) items.push(prItem(pr));
        }
        const r = await exec("gh", ["api", "graphql", "-f", `q=is:pr ${this.repo ? `repo:${this.repo} ` : ""}${q} sort:updated-desc`, "-f",
          `query=query($q: String!) { search(query: $q, type: ISSUE, first: 10) { nodes { ... on PullRequest { ${PR_FIELDS} } } } }`]);
        if (r.code === 0) items.push(...JSON.parse(r.stdout).data.search.nodes.filter((p) => p.number).map(prItem));
      } catch {}
      if (this.live.q !== q) return;
      this.live = { q, items, loading: false };
      cx.notify();
    });
    cx.notify();
  }

  // One line per file (the first hit), at most 30: rg when installed, else git grep.
  searchContent(q, cx) {
    const files = FILES.get(this.folder);
    if (!files) return;
    this.grep = { q, items: this.grep.items, loading: true };
    const script = 'q=$1; if command -v rg >/dev/null 2>&1; then rg --max-count 1 -n -i -F --no-heading --color never -e "$q" .; '
      + 'elif [ "$2" = git ]; then git grep -n -I -i -F --max-count 1 -e "$q" -- .; else grep -rnIiF -m 1 --exclude-dir=.git --exclude-dir=node_modules -e "$q" .; fi 2>/dev/null | head -n 30';
    cx.spawn(async (cx) => {
      let items = [];
      try {
        const r = await exec("sh", ["-c", script, "search", q, files.git ? "git" : "plain"], { cwd: files.root, on: files.on });
        items = r.stdout.split("\n").map((l) => l.match(/^(?:\.\/)?(.+?):(\d+):(.*)$/)).filter(Boolean)
          .map(([, path, line, text]) => ({ path, line: Number(line), text: text.trim().slice(0, 200) }));
      } catch {}
      if (this.grep.q !== q) return;
      this.grep = { q, items, root: files.root, loading: false };
      cx.notify();
    });
  }

  // Results by group, best first; recent picks score higher.
  groups() {
    const ws = words(this.q);
    const boost = (id) => { const i = this.recent.findIndex((r) => r.id === id); return i < 0 ? 0 : 30 - i; };
    // Scattered-letter matches drop out when a group has much closer ones.
    const ranked = (rows) => {
      const out = rows.filter(Boolean).map((r) => ({ ...r, score: r.score + boost(r.id) })).sort((a, b) => b.score - a.score);
      return out.filter((r) => r.line || r.score >= out[0]?.score * 0.3);
    };
    const out = {};
    const add = (group, rows) => (out[group] = ranked(rows).slice(0, GROUPS.find((g) => g.id === group).max));
    const item = (group, id, title, sub, act, extra = {}) => {
      const m = fields(ws, title, sub);
      return m && { group, id, title, sub, act, ...m, ...extra };
    };

    add("agents", agents().map((a) => item("agents", `agent:${a.address}`, a.title || a.program?.name || a.address,
      `${a.space_name} › ${a.tab_name}`, { agent: a.address }, { status: a.status, program: a.program })));

    const tabs = [];
    for (const s of spaces()) {
      tabs.push(item("tabs", `space:${s.id}`, s.name, `space · ${s.tabs.length} tab${s.tabs.length > 1 ? "s" : ""}${s.branch ? ` · ${s.branch}` : ""}`,
        { run: "space.select", args: { id: s.id } }, { status: s.status, space: true }));
      for (const tb of s.tabs.filter((x) => !x.settled)) {
        tabs.push(item("tabs", `tab:${tb.id}`, tb.named ? tb.name : `Tab ${tb.name}`, s.name, { run: "tab.select", args: { id: tb.id } }, { status: tb.status }));
      }
    }
    add("tabs", tabs);

    const inbox = Array.isArray(shared("inbox.items")) ? shared("inbox.items") : [];
    const prs = new Map();
    const pr = (p) => {
      if (prs.has(p.url)) return;
      const preview = { mod: "pr-preview", props: { url: p.url, key: p.key }, kind: "dialog", width: 0.85, height: 0.9 };
      prs.set(p.url, item("prs", `pr:${p.url}`, `#${p.number ?? p.key.split("#")[1]} ${p.title}`, [p.repo, p.meta].filter(Boolean).join(" · "),
        { overlay: preview }, { ci: p.ci }));
    };
    inbox.filter((i) => i.preview === "pr-preview").forEach(pr);
    if (ws.length) this.live.items.forEach(pr);
    add("prs", [...prs.values()]);

    const tickets = inbox.filter((i) => i.preview === "jira-preview").map((i) => item("jira", `jira:${i.key}`, `${i.key} ${i.title}`, i.status ?? i.meta ?? "",
      { overlay: { mod: "jira-preview", props: { key: i.key }, kind: "dialog", width: 820, height: 0.9 } }));
    const key = this.q.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9]+-\d+$/.test(key) && !inbox.some((i) => i.key === key)) {
      tickets.push({ group: "jira", id: `jira:${key}`, title: key, sub: "open ticket", score: 200, hits: [...key].map((_c, i) => i), subHits: [],
        act: { overlay: { mod: "jira-preview", props: { key }, kind: "dialog", width: 820, height: 0.9 } } });
    }
    add("jira", tickets);

    add("files", ws.length ? this.files(ws) : []);

    const have = new Set(layouts());
    add("commands", [
      ...commands().map((c) => item("commands", `cmd:${c.name}`, c.name, [c.about, ...c.args.filter((a) => a.required).map((a) => `{${a.name}}`)].join(" "),
        { run: c.name })),
      ...EXTRA.filter((c) => !c.layout || have.has(c.layout)).map((c) => item("commands", `cmd:${c.name}`, c.name, c.about, { run: c.run, args: c.args })),
    ]);
    return out;
  }

  // File names (fuzzy on the path, matched by scan()), then content hits.
  files(ws) {
    const f = FILES.get(this.folder);
    if (!f) return [];
    const rows = this.names?.q === this.q && this.names.files === f ? [...this.names.rows] : [];
    if (this.grep.root === f.root && this.grep.q === this.q.trim()) {
      for (const [n, g] of this.grep.items.entries()) {
        rows.push({ group: "files", id: `line:${f.root}/${g.path}:${g.line}`, title: `${g.path}:${g.line}`, sub: g.text, hits: [],
          subHits: match(ws, g.text)?.hits ?? [], score: -1000 - n, line: true, act: { file: `${f.root}/${g.path}`, line: g.line } });
      }
    }
    return rows;
  }

  // Matches every file name against the query a few ms at a time, so typing stays quick in a big repo.
  scan(cx) {
    const f = FILES.get(this.folder);
    const q = this.q;
    const ws = words(q);
    if (!f || !ws.length || (this.names?.q === q && this.names.files === f)) return;
    const token = (this.scanning = (this.scanning ?? 0) + 1);
    const found = [];
    let i = 0;
    const step = (cx) => {
      if (token !== this.scanning) return;
      const until = Date.now() + 8;
      for (; i < f.paths.length && (i % 256 || Date.now() < until); i++) {
        const m = matchPath(ws, f.paths[i], f.lower[i]);
        if (m) found.push({ i, score: m.score, hits: m.hits });
      }
      if (i < f.paths.length) return cx.timer.after(0, step);
      found.sort((a, b) => b.score - a.score);
      // The file name first, its folder beside it.
      this.names = { q, files: f, rows: found.slice(0, 10).map((m) => {
        const path = f.paths[m.i];
        const cut = path.lastIndexOf("/") + 1;
        return { group: "files", id: `file:${f.root}/${path}`, title: path.slice(cut), sub: path.slice(0, Math.max(0, cut - 1)),
          hits: m.hits.filter((h) => h >= cut).map((h) => h - cut), subHits: m.hits.filter((h) => h < cut), score: m.score,
          act: { file: `${f.root}/${path}` } };
      }) };
      cx.notify();
    };
    step(cx);
  }

  // Rows top to bottom: [{ head }, { item }...]; empty query: recent picks, then the agents.
  rows() {
    const g = this.groups();
    const out = [];
    if (!this.q.trim() && !this.only) {
      const live = new Map(Object.values(g).flat().map((r) => [r.id, r]));
      const recent = this.recent.map((r) => live.get(r.id) ?? ((r.act?.run || r.act?.agent) && /^(agent|space|tab):/.test(r.id) ? null : { ...r, hits: [], subHits: [] })).filter(Boolean).slice(0, 8);
      if (recent.length) {
        out.push({ head: { id: "recent", title: "Recent" } });
        recent.forEach((r) => out.push({ item: r }));
      }
    }
    const empty = !this.q.trim();
    GROUPS.forEach((grp, n) => {
      if (this.only && grp.id !== this.only) return;
      const items = this.only ? (g[grp.id] ?? []).slice(0, empty ? 30 : undefined) : empty && grp.id !== "agents" ? [] : g[grp.id] ?? [];
      if (!items.length) return;
      out.push({ head: { ...grp, n: n + 1 } });
      items.forEach((r) => out.push({ item: r }));
    });
    return out.slice(0, LIST_MAX);
  }

  // Before anything is typed: the character that limits a search to one kind, the active one lit.
  legend(t) {
    const st = this.s ?? style();
    const kinds = [[">", "Commands", "commands"], ["@", "Agents", "agents"], ["#", "PRs", "prs"], ["!", "Tickets", "jira"], ["/", "Files", "files"]];
    return v_flex().flex_none().gap(6).px(2)
      .child(div().text_size(11.5).text_color(t.dim).child("Start with a character to search one kind:"))
      .child(h_flex().flex_wrap().gap(6).children(kinds.map(([k, name, id]) => h_flex().id(`kind-${id}`).gap(6).items_center().px(8).py(3)
        .cursor_pointer().hover((h) => h.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          // The same as typing the character: another click on the lit one clears it.
          this.input.set_value(this.only === id ? "" : k);
          this.changed(cx);
          this.input.focus();
        })
        .rounded(rad(st, 6)).border(1).border_color(this.only === id ? t.accent : t.border).when(this.only === id, (el) => el.bg(`${t.accent}22`))
        .child(div().text_color(t.accent).font_semibold().child(k))
        .child(div().text_size(11.5).text_color(this.only === id ? t.foreground : t.muted).child(name)))));
  }

  selected() {
    return this.pickable?.[this.at] ?? null;
  }

  // ⌘n: the first row of group n. Tab: the next group with rows after the selected one's.
  jump(n) {
    const id = GROUPS[n]?.id;
    const i = (this.pickable ?? []).findIndex((r) => r.group === id && !r.recent);
    if (i >= 0) this.at = i;
  }

  step(dir) {
    const list = this.pickable ?? [];
    if (!list.length) return;
    const starts = list.map((r, i) => (i === 0 || r.group !== list[i - 1].group || r.recent !== list[i - 1].recent ? i : -1)).filter((i) => i >= 0);
    const cur = starts.filter((i) => i <= this.at).length - 1;
    this.at = starts[(cur + dir + starts.length) % starts.length];
  }

  remember(r) {
    const { id, group, title, sub, act } = r;
    this.recent = [{ id, group, title, sub, act }, ...this.recent.filter((x) => x.id !== id)].slice(0, RECENT_MAX);
    try { localStorage.setItem("recent", JSON.stringify(this.recent)); } catch {}
  }

  go(r, alt) {
    if (!r || this.gone) return;
    this.gone = true;
    this.remember(r);
    const a = r.act;
    closeOverlay(props().overlay);
    if (a.file) {
      if (alt) return openInEditor(a.file, a.line);
      const viewer = { file: a.file, line: a.line ?? null };
      const pane = focused()?.pane;
      if (pane) run("pane.split", { direction: "right", pane, mod: "search", props: viewer });
      else run("tab.new", { name: a.file.split("/").pop(), mod: "search", props: viewer });
    } else if (a.agent) focusAgent(a.agent);
    else if (a.overlay) openOverlay(a.overlay);
    else run(a.run, a.args);
  }

  // Text with its matched characters in the highlight color.
  hl(text, hits, color, hi) {
    if (!hits?.length) return div().min_w(0).truncate().text_color(color).child(text);
    const on = new Set(hits);
    const runs = [];
    for (let i = 0; i < text.length; i++) {
      const last = runs[runs.length - 1];
      if (last && last.on === on.has(i)) last.s += text[i];
      else runs.push({ s: text[i], on: on.has(i) });
    }
    return h_flex().min_w(0).overflow_hidden().children(runs.map((r) =>
      div().flex_none().whitespace_nowrap().text_color(r.on ? hi : color).when(r.on, (d) => d.font_bold()).child(r.s)));
  }

  glyph(s, t, r) {
    const st = r.status;
    if (r.group === "agents" || (r.group === "tabs" && st)) {
      if (s.name !== "soft" && st) return badge(s, t, LETTER[st] ?? "?", t[st] ?? t.dim, st !== "idle");
      if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
      return div().w(12).flex_none().text_color(t[st] ?? t.dim).child(st === "idle" ? "○" : st ? "●" : "·");
    }
    if (r.group === "prs" && r.ci) return div().w(12).flex_none().child(div().size(7).rounded(4).bg({ pass: t.ansi2, fail: t.blocked, pending: t.working }[r.ci] ?? t.dim));
    const icon = r.group === "tabs" && r.space ? "folder" : ICON[r.group] ?? "square";
    return svg(`mods/workspace-chrome/${icon}.svg`).size(13).flex_none().text_color(t.dim);
  }

  // A key in the list; true when it was ours.
  key(k) {
    const group = k.match(/^cmd-([1-6])$/);
    if (k === "escape") closeOverlay(props().overlay);
    else if (k === "down" || k === "ctrl-n") this.at = this.pickable.length ? (this.at + 1) % this.pickable.length : 0;
    else if (k === "up" || k === "ctrl-p") this.at = this.pickable.length ? (this.at + this.pickable.length - 1) % this.pickable.length : 0;
    else if (k === "tab") this.step(1);
    else if (k === "shift-tab") this.step(-1);
    else if (group) this.jump(Number(group[1]) - 1);
    else if (k === "enter" || k === "cmd-enter") this.go(this.selected(), k === "cmd-enter");
    else return false;
    this.auto = false;
    return true;
  }

  render() {
    if (this.viewer) return this.renderViewer();
    const t = theme();
    const s = style();
    const rows = this.rows();
    // Recent rows are copies: mark them so Tab treats them as their own group.
    let inRecent = false;
    for (const r of rows) {
      if (r.head) inRecent = r.head.id === "recent";
      else if (inRecent) r.item = r.item.recent ? r.item : { ...r.item, recent: true };
    }
    this.pickable = rows.filter((r) => r.item).map((r) => r.item);
    // Until you move, the best match anywhere is selected.
    if (this.auto && this.q.trim()) this.at = this.pickable.reduce((b, r, i) => (r.score > this.pickable[b].score ? i : b), 0);
    this.at = Math.max(0, Math.min(this.at, this.pickable.length - 1));
    const sel = this.pickable[this.at];

    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += r.head ? H.head : H.row; });
    const total = y;
    const height = this.listHeight ?? 400;
    const maxScroll = Math.max(0, total - height);
    const si = rows.findIndex((r) => r.item === sel);
    if (si >= 0) {
      // Keep the group's heading in view when its first row is selected.
      const top = si > 0 && rows[si - 1].head ? tops[si - 1] : tops[si];
      if (top < this.scroll) this.scroll = top;
      if (tops[si] + H.row > this.scroll + height) this.scroll = tops[si] + H.row - height;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const h = (r) => (r.head ? H.head : H.row);
    const visible = (i) => tops[i] + h(rows[i]) > this.scroll && tops[i] < this.scroll + height;
    const place = (el, i) => el.absolute().left(0).right(0).top(tops[i] - this.scroll).h(h(rows[i]));

    const busy = this.live.loading || this.grep.loading;
    const row = (r) => {
      if (r.head) {
        const tag = r.head.n ? `⌘${r.head.n}` : null;
        if (s.name !== "soft") return h_flex().px(6).pt(8).items_end().child(heading(s, t, r.head.title, tag));
        return h_flex().px(10).pt(10).pb(2).items_center().justify_between().text_size(11).font_semibold().text_color(t.dim)
          .child(r.head.title).when(Boolean(tag), (el) => el.child(div().text_size(10.5).font_normal().child(tag)));
      }
      const it = r.item;
      const on = it === sel;
      return h_flex().id(`sr-${it.recent ? "r-" : ""}${it.id}`).mx(4).px(10).gap(10).items_center().rounded(rad(s, 7)).cursor_pointer()
        .when(on, (el) => el.bg(t.selected ?? t.hover))
        .when(on && s.name === "deck", (el) => el.border_l(2).border_color(t.accent))
        .hover((st) => st.bg(t.hover))
        .on_click((e, _cx) => this.go(it, e.modifiers?.platform))
        .child(this.glyph(s, t, it))
        .child(div().flex_1().min_w(0).child(this.hl(it.title, it.hits, t.foreground, t.accent)))
        .when(Boolean(it.sub), (el) => el.child(div().max_w(260).min_w(0).text_size(11.5)
          .child(this.hl(it.sub, it.subHits, t.dim, t.accent))));
    };

    const hint = (k, what) => h_flex().gap(4).child(div().text_color(t.muted).child(k)).child(div().child(what));
    return v_flex()
      .id("search")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .when(Boolean(s.mono), (el) => el.font_family(s.mono))
      .on_key_down((e, cx) => {
        if (this.key(e.keystroke)) { cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().items_center().justify_between().gap(10)
        .child(s.name === "soft" ? div().text_size(15).font_semibold().text_color(t.foreground).child("Search") : heading(s, t, "Search", "⌘⇧O"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(rad(s, 9)).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .when(busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.dim).spin(900))))
      .when(!this.q.trim(), (el) => el.child(this.legend(t)))
      .child(v_flex().id("sr-list").flex_1().min_h(0).relative().overflow_hidden()
        .on_size_change((size, cx) => { this.listHeight = size.height / (settings().zoom ?? 1); cx.notify(); })
        .on_scroll_wheel((e, cx) => {
          this.auto = false;
          this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
          // The selection follows the wheel, so the next frame doesn't scroll back to it.
          const idx = (it) => rows.findIndex((r) => r.item === it);
          while (this.at < this.pickable.length - 1 && tops[idx(this.pickable[this.at])] < this.scroll) this.at++;
          while (this.at > 0 && tops[idx(this.pickable[this.at])] + H.row > this.scroll + height) this.at--;
          cx.notify();
        })
        .children(rows.length
          ? rows.map((r, i) => (visible(i) ? place(row(r), i) : null)).filter(Boolean)
          : [div().p(12).text_color(t.dim).child(this.q.trim() ? (busy ? "Searching…" : "Nothing matches") : "")]))
      .child(h_flex().flex_none().gap(14).text_size(11).text_color(t.dim)
        .child(hint("↑↓", "move")).child(hint("↵", "open")).child(hint("⌘↵", "in editor")).child(hint("⇥", "next group")).child(hint("> @ # ! /", "one group"))
        .child(div().flex_1()).child(div().truncate().child(this.folder ? this.folder.replace(home(), "~") : "")));
  }

  // The viewer: one file, read-only, opened from the search as a pane.
  initViewer(p, cx) {
    this.viewer = { file: p.file, line: p.line ?? null, code: null, error: null };
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(p.file);
        if (text === null) this.viewer.error = "This file is no longer available";
        else if (text.includes("\0")) this.viewer.error = "Binary file · no text preview";
        else {
          const t = theme();
          const ext = p.file.includes(".") ? p.file.split(".").pop() : "txt";
          this.viewer.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
            value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
            font_family: settings().font_family, font_size: 12,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        }
      } catch { this.viewer.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  renderViewer() {
    const t = theme();
    const s = style();
    const v = this.viewer;
    return v_flex().id("sv").track_focus(this.handle).size_full().min_h(0).bg(t.background)
      .child(h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(v.file.replace(home(), "~") + (v.line ? `  · line ${v.line}` : "")))
        .child(div().id("sv-editor").flex_none().px(8).py(2).rounded(rad(s, 6)).border(1).border_color(t.border).text_size(11).text_color(t.muted)
          .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click(() => openInEditor(v.file, v.line))
          .child(label(s, "Open in editor"))))
      .child(v.code ? Editor.new(v.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(v.error || "Loading file…"));
  }

  close() {
    this.viewer?.code?.release();
  }
}
