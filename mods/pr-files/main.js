// The PR the focused agent is reviewing, in the side panel: its files and diff, with line comments that
// join the PR preview's pending review. Follows the agent in focus (or the one a chat pane stands for)
// and stays on it when focus moves elsewhere. The PR: a URL you pasted for that agent, else the
// session's inbox.url label, else a PR link in its first prompt, else its inbox.item key against the repo.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, focused, agents, terminals, theme, settings, shared, setShared, openOverlay, home, notify } from "herdr";
import { style, label, rad, badge, heading, brackets } from "./style.js";
import { modes } from "./mode.js";
import { parseDiff, agentMessage } from "./diff.js";
import { sendToAgent, agentName } from "./session.js";
import { tokens, langFor, paletteFor } from "./highlight.js";
import { loadThreads, place, threadsAt, elsewhere, fileCounts, summary, card, elsewhereBlock, allComments, commentList, jumpIndex, Replies } from "./threads.js";

const ICONS = "mods/workspace-chrome";
const PENDING = "pr-preview.pending";
const PICKED = "pr-files.urls";
const PR_URL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const FIELDS = "title,state,isDraft,reviewDecision,statusCheckRollup";
const MAX_LINES = 1500;
const RETRY_MS = 15000;

const pendingFor = (url) => (shared(PENDING) ?? {})[url] ?? [];
const setPendingFor = (url, list) => setShared(PENDING, { ...(shared(PENDING) ?? {}), [url]: list });
const picked = () => shared(PICKED) ?? {};
const keyOf = (url) => {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
};
const dashed = (id) =>
  id.length === 32 ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : id;

// Check runs report a conclusion, commit statuses a state.
function ci(rollup = []) {
  if (!rollup.length) return null;
  const word = (c) => c.conclusion || c.state || c.status;
  if (rollup.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(word(c)))) return "fail";
  if (rollup.some((c) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING"].includes(word(c)))) return "pending";
  return "pass";
}

const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "needs review" };

export default class PrFiles extends View {
  init(_props, cx) {
    this.agent = null;
    this.found = new Map();
    this.resolving = new Set();
    this.tried = new Set();
    this.prs = new Map();
    this.sel = new Map();
    this.draft = null;
    this.open = new Set();
    this.replies = new Replies({ data: () => this.prs.get(this.url)?.threads, reload: (cx) => this.load(this.url, cx, true),
      agent: () => this.agent, files: () => this.prs.get(this.url)?.files });
    this.jump = null;
    this.showComments = false;
    this.width = 400;
    this.filter = "";
    this.filterInput = InputState.new({ placeholder: "Filter files" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value().trim().toLowerCase(); cx.notify(); });
    this.urlInput = InputState.new({ placeholder: "Paste a PR URL" });
    this.urlInput.on("submit", (_e, cx) => this.pick(cx));
    cx.timer.every(RETRY_MS, (cx) => { if (this.agent && !this.urlFor(this.agent)) this.resolve(this.agent, cx); });
  }

  // The agent in focus: the focused terminal, or the one a chat pane stands for.
  focusedAgent() {
    const f = focused();
    let address = f?.terminal;
    if (!address && f?.pane) address = Object.entries(modes()).find(([, m]) => m.chat === f.pane)?.[0];
    return address && agents().some((a) => a.address === address) ? address : null;
  }

  urlFor(address) {
    return picked()[address] ?? this.found.get(address) ?? null;
  }

  resolve(address, cx) {
    if (this.found.has(address) || this.resolving.has(address)) return;
    this.resolving.add(address);
    cx.spawn(async (cx) => {
      const url = await this.find(address).catch(() => null);
      this.resolving.delete(address);
      this.tried.add(address);
      if (url) this.found.set(address, url);
      cx.notify();
    });
  }

  async find(address) {
    const term = terminals().find((x) => x.address === address);
    if (!term) return null;
    const tagged = (term.labels?.["inbox.url"] ?? "").match(PR_URL)?.[0];
    return tagged ?? (await this.fromTranscript(term)) ?? (await this.fromKey(term));
  }

  // A PR link in the session's first prompt, from its Claude transcript.
  async fromTranscript(term) {
    const id = term.records?.session?.app;
    if (!id) return null;
    const dir = `${home()}/.claude/projects`;
    const file = `${dashed(id)}.jsonl`;
    let r = await exec("head", ["-c", "400000", `${dir}/${(term.cwd ?? "").replace(/[^A-Za-z0-9]/g, "-")}/${file}`]);
    // The session may have started in another folder.
    if (r.code !== 0) {
      const path = (await exec("find", [dir, "-maxdepth", "2", "-name", file])).stdout.split("\n")[0];
      if (!path) return null;
      r = await exec("head", ["-c", "400000", path]);
    }
    for (const line of r.stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== "user" || rec.isMeta || rec.isSidechain) continue;
      const c = rec.message?.content;
      const text = typeof c === "string" ? c : (c ?? []).map((b) => b.text ?? "").join("\n");
      if (!text.trim() || /^\s*<(command-|local-command|system-reminder)/.test(text)) continue;
      return text.match(PR_URL)?.[0] ?? null;
    }
    return null;
  }

  // An inbox key or tab name like "trainual#34772", in the repo the agent runs in.
  async fromKey(term) {
    const name = term.labels?.["inbox.item"] ?? agents().find((a) => a.address === term.address)?.tab_name ?? "";
    const m = name.match(/^([\w.-]+)#(\d+)$/);
    if (!m || !term.cwd) return null;
    const r = await exec("git", ["--no-optional-locks", "-C", term.cwd, "remote", "get-url", "origin"]);
    const remote = r.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
    if (!remote || remote[2].toLowerCase() !== m[1].toLowerCase()) return null;
    return `https://github.com/${remote[1]}/${remote[2]}/pull/${m[2]}`;
  }

  pick(cx) {
    const url = this.urlInput.value().match(PR_URL)?.[0];
    if (!url || !this.agent) {
      this.pickError = "That isn't a GitHub pull request URL.";
      return cx.notify();
    }
    setShared(PICKED, { ...picked(), [this.agent]: url });
    this.urlInput.set_value("");
    this.pickError = null;
    this.picking = false;
    cx.notify();
  }

  unpick(cx) {
    const next = { ...picked() };
    delete next[this.agent];
    setShared(PICKED, next);
    cx.notify();
  }

  // The PR's header facts and its diff, once per PR (Refresh fetches again).
  load(url, cx, again = false) {
    const had = this.prs.get(url);
    if (had && (!again || had.loading)) return;
    const entry = had ?? { meta: null, files: null, error: null };
    entry.loading = true;
    this.prs.set(url, entry);
    cx.spawn(async (cx) => {
      const [view, diff, threads] = await Promise.all([
        exec("gh", ["pr", "view", url, "--json", FIELDS], { cwd: home() }),
        exec("gh", ["pr", "diff", url], { cwd: home() }),
        loadThreads(url).catch((e) => ({ items: [], pending: 0, error: String(e) })),
      ]);
      entry.threads = threads;
      if (view.code === 0) entry.meta = JSON.parse(view.stdout);
      if (diff.code !== 0) entry.error = diff.stderr.trim() || "gh pr diff failed";
      else {
        entry.error = null;
        entry.files = parseDiff(diff.stdout);
      }
      if (entry.files) place(threads.items, entry.files);
      entry.loading = false;
      cx.notify();
    });
  }

  openReview(url) {
    openOverlay({ mod: "pr-preview", props: { url, key: keyOf(url) }, kind: "dialog", width: 0.85, height: 0.9 });
  }

  startDraft(url, path, side, line, cx) {
    this.draft = { url, path, side, line, input: TextareaState.new({ placeholder: "Comment on this line (markdown)", rows: 3 }) };
    cx.notify();
  }

  addDraft(cx) {
    const body = this.draft.input.value().trim();
    if (!body) return;
    const { url, path, side, line } = this.draft;
    setPendingFor(url, [...pendingFor(url), { id: `${Date.now()}`, path, side, line, body }]);
    this.draft = null;
    cx.notify();
  }

  // Line comments to the agent's chat as one message. From the draft it closes; pending ones stay pending.
  toAgent(url, comments, cx, fromDraft) {
    const address = this.agent;
    if (!address || !comments.length || this.sending) return;
    this.sending = fromDraft ? "draft" : "all";
    this.sendError = null;
    if (fromDraft) this.draft.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const error = await sendToAgent(address, agentMessage(url, this.prs.get(url)?.files, comments));
      this.sending = null;
      if (error && fromDraft && this.draft) this.draft.error = error;
      else if (error) this.sendError = error;
      else {
        if (fromDraft) this.draft = null;
        notify({ title: `Sent to ${agentName(address)}`, level: "info", timeout: 3000 });
      }
      cx.notify();
    });
  }

  sendDraft(cx) {
    const body = this.draft.input.value().trim();
    if (!body) return;
    const { url, path, side, line } = this.draft;
    this.toAgent(url, [{ path, side, line, body }], cx, true);
  }

  // A small action in the look: a soft outlined button, a deck chip, an lcars pill.
  button(t, s, id, text, icon, primary, onClick) {
    const lcars = s.name === "lcars";
    const deck = s.name === "deck";
    const ink = primary || lcars ? t.solid_foreground : t.muted;
    return h_flex().id(id).flex_none().gap(5).items_center().px(lcars ? 10 : 7).py(lcars ? 2 : 3).rounded(rad(s, 6))
      .when(primary, (el) => el.bg(t.solid))
      .when(!primary && lcars, (el) => el.bg(t.ansi5))
      .when(!primary && !lcars, (el) => el.border(1).border_color(t.border))
      .hover((el) => (primary || lcars ? el.opacity(0.85) : el.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .when(Boolean(icon) && !lcars, (el) => el.child(svg(icon).size(12).text_color(ink)))
      .child(div().text_size(deck ? 10 : 11.5).when(deck, (el) => el.font_bold())
        .when(lcars, (el) => el.font_family(s.head).text_size(14).pt(1)).text_color(ink).child(label(s, text)));
  }

  copyLink(t, s, url) {
    return this.button(t, s, "copy-link", this.copied ? "Copied" : "Copy link", this.copied ? `${ICONS}/check.svg` : "mods/pr-files/link.svg", false, (_e, cx) => {
      cx.write_to_clipboard(url);
      this.copied = true;
      cx.notify();
      cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
    });
  }

  // CI and review, as the inbox rows show them.
  status(t, s, meta) {
    const state = ci(meta.statusCheckRollup);
    const review = meta.isDraft ? null : meta.reviewDecision;
    const ciColor = { pass: t.ansi2, fail: t.blocked, pending: t.working }[state];
    const reviewColor = { APPROVED: t.ansi2, CHANGES_REQUESTED: t.blocked }[review] ?? t.dim;
    const closed = meta.state === "MERGED" ? ["Merged", t.ansi5] : meta.state === "CLOSED" ? ["Closed", t.blocked] : meta.isDraft ? ["Draft", t.muted] : null;
    const pulse = (el) => el.when(state === "pending", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1100 }));
    if (s.name !== "soft") {
      return h_flex().gap(3).items_center().flex_none()
        .when(Boolean(closed), (el) => el.child(badge(s, t, closed?.[0] ?? "", closed?.[1] ?? t.muted, false)))
        .when(Boolean(ciColor), (el) => el.child(pulse(div()).child(badge(s, t, "C", ciColor))))
        .when(Boolean(REVIEW[review]), (el) => el.child(badge(s, t, "R", reviewColor, review !== "REVIEW_REQUIRED")));
    }
    return h_flex().gap(6).items_center().flex_none()
      .when(Boolean(closed), (el) => el.child(div().text_size(10.5).text_color(closed?.[1] ?? t.muted).child(closed?.[0] ?? "")))
      .when(Boolean(ciColor), (el) => el.child(pulse(div().size(7).rounded(4).bg(ciColor))))
      .when(Boolean(REVIEW[review]), (el) => el.child(div().text_size(10.5).text_color(reviewColor).child(REVIEW[review])));
  }

  header(t, s, url, entry) {
    const soft = s.name === "soft";
    const top = h_flex().gap(6).items_center()
      .child(soft ? div().flex_1().font_semibold().text_size(13).text_color(t.foreground).child("Pull request")
        : heading(s, t, "Pull request", s.name === "lcars" ? "09-pr" : "09.pr"))
      .when(s.name === "deck", (el) => el.child(div().flex_1()))
      .when(Boolean(url), (el) => el
        .child(this.button(t, s, "refresh", entry?.loading ? "Loading" : "Refresh", null, false, (_e, cx) => this.load(url, cx, true)))
        .child(this.copyLink(t, s, url))
        .child(this.button(t, s, "open-review", "Open review", `${ICONS}/square-pen.svg`, true, () => this.openReview(url))));
    const meta = entry?.meta;
    const fromPicked = Boolean(this.agent && picked()[this.agent]);
    return v_flex().flex_none().px(12).pt(10).pb(8).gap(6).border_b(1).border_color(t.border)
      .child(top)
      .when(Boolean(url), (el) => el.child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_none().text_size(12).font_semibold().text_color(t.accent)
          .when(s.name === "lcars", (el) => el.font_family(s.head).text_size(16)).child(keyOf(url)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(soft ? t.foreground : t.muted).child(meta?.title ?? ""))
        .when(Boolean(meta), (el) => el.child(this.status(t, s, meta)))
        .when(fromPicked, (el) => el.child(div().id("unpick").flex_none().text_size(10.5).text_color(t.dim)
          .hover((el) => el.text_color(t.foreground)).on_click((_e, cx) => this.unpick(cx)).child(label(s, "Clear"))))));
  }

  // No PR found for this agent: paste one.
  picker(t, s, why) {
    return v_flex().p(12).gap(8)
      .child(div().text_size(12).text_color(t.muted).child(why))
      .child(div().id("pick-url").h(30).px(9).flex().items_center().rounded(rad(s, 7)).border(1).border_color(t.border).bg(t.surface)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.urlInput).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(this.pickError ? t.blocked : t.dim)
          .child(this.pickError ?? "Remembered for this agent."))
        .child(this.button(t, s, "pick", "Show PR", null, true, (_e, cx) => this.pick(cx))));
  }

  fileList(t, s, url, files) {
    const shown = this.filter ? files.filter((f) => f.name.toLowerCase().includes(this.filter)) : files;
    const adds = files.reduce((n, f) => n + f.adds, 0);
    const dels = files.reduce((n, f) => n + f.dels, 0);
    const pending = pendingFor(url);
    const open = this.sel.get(url);
    const threads = this.prs.get(url)?.threads;
    const all = allComments(pending, threads);
    const bar = h_flex().px(12).py(6).gap(8).items_center()
      .child(div().text_size(11).text_color(t.muted).child(label(s, `${files.length} files`)))
      .child(div().text_size(11).text_color(t.ansi2).child(`+${adds}`))
      .child(div().text_size(11).text_color(t.ansi1).child(`−${dels}`))
      .when(Boolean(summary(threads)), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(label(s, summary(threads)))))
      .child(div().flex_1())
      .child(this.button(t, s, "view-comments", this.showComments ? "Files" : `Comments · ${all.total}`, null, false, (_e, cx) => { this.showComments = !this.showComments; cx.notify(); }))
      .when(pending.length > 0 && Boolean(this.agent), (el) => el.child(this.button(t, s, "send-all",
        this.sending === "all" ? "Sending…" : `Send ${pending.length} to agent`, `${ICONS}/terminal.svg`, false, (_e, cx) => this.toAgent(url, pendingFor(url), cx, false))))
      .child(pending.length
        ? this.button(t, s, "submit-review", `Submit review · ${pending.length}`, `${ICONS}/square-pen.svg`, true, () => this.openReview(url))
        : div().text_size(10.5).text_color(t.dim).child(label(s, "Click a line number to comment")));
    const filter = files.length > 8 && div().id("filter").mx(8).mb(4).h(26).px(8).flex().items_center().rounded(rad(s, 6)).border(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(this.filterInput).w_full().text_size(11.5).text_color(t.foreground));
    const rows = shown.map((f, i) => {
      const parts = f.name.split("/");
      const name = parts.pop();
      const notes = pending.filter((c) => c.path === f.name).length;
      const counts = fileCounts(threads?.items ?? [], f.name);
      return h_flex().id(`file-${i}`).h(26).flex_none().px(8).gap(8).items_center().rounded(rad(s, 6)).cursor_pointer()
        .when(open === f.name, (el) => el.bg(t.selected))
        .when(s.name === "deck" && open === f.name, (el) => el.border_l(2).border_color(t.accent))
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => { this.sel.set(url, f.name); this.draft = null; this.jump = null; cx.notify(); })
        .child(h_flex().flex_1().min_w(0).text_size(12)
          .child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : ""))
          .child(div().flex_none().max_w(260).truncate().text_color(t.foreground).child(name)))
        .when(counts.threads > 0, (el) => el.child(div().flex_none().px(5).rounded(rad(s, 5)).bg(`${t.accent}22`).text_size(10).text_color(t.accent).child(String(counts.threads))))
        .when(counts.pending > 0, (el) => el.child(div().flex_none().px(5).rounded(rad(s, 5)).bg(`${t.ansi5}22`).text_size(10).text_color(t.ansi5).child(String(counts.pending))))
        .when(notes > 0, (el) => el.child(div().flex_none().px(5).rounded(rad(s, 5)).bg(`${t.working}22`).text_size(10).text_color(t.working).child(String(notes))))
        .when(f.adds > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.adds}`)))
        .when(f.dels > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.dels}`)));
    });
    if (this.showComments) {
      return v_flex().flex_none().border_b(1).border_color(t.border).child(bar)
        .child(v_flex().id("pr-comment-list").flex_none().max_h(320).px(6).pb(8).overflow_y_scrollbar()
          .child(commentList(t, s, all, (r, cx) => {
            this.sel.set(url, r.path);
            this.jump = { url, path: r.path, side: r.side, line: r.line };
            this.draft = null;
            this.showComments = false;
            cx.notify();
          })));
    }
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(bar)
      .when(Boolean(this.sendError), (el) => el.child(div().px(12).pb(4).text_size(11).text_color(t.blocked).child(this.sendError ?? "")))
      .when(Boolean(filter), (el) => el.child(filter))
      .child(v_flex().id("pr-file-list").flex_none().h(Math.min(220, Math.max(36, shown.length * 26 + 10))).px(6).pb(6).overflow_y_scrollbar()
        .children(rows)
        .when(!shown.length, (el) => el.child(div().p(6).text_size(11.5).text_color(t.dim).child("No files match."))));
  }

  code(t, text, lang, colors) {
    if (!lang || !text) return div().child(text || " ");
    return h_flex().children(tokens(text, lang).map((tok) => div().text_color(tok.kind ? colors[tok.kind] : t.foreground).child(tok.text)));
  }

  // One diff line; its number starts a comment on that side (removed lines: the old file).
  line(t, s, l, i, url, path, lang, colors) {
    const hunk = l.kind === "hunk";
    const n = hunk ? null : l.kind === "del" ? l.oldNo : l.newNo;
    const side = l.kind === "del" ? "LEFT" : "RIGHT";
    const j = this.jump;
    const target = !hunk && j && j.url === url && j.path === path && j.line != null && j.line === (j.side === "LEFT" ? l.oldNo : l.newNo);
    const tint = target ? `${t.accent}2a` : { add: `${t.ansi2}12`, del: `${t.ansi1}16`, hunk: `${t.accent}10` }[l.kind];
    const mark = { add: t.ansi2, del: t.ansi1 }[l.kind];
    const num = div().w(42).flex_none().pl(4).pr(8).text_right().text_color(t.dim).opacity(0.8).child(n == null ? "" : String(n));
    return h_flex().id(`l-${i}`).min_w_full().flex_none().items_start().whitespace_nowrap()
      .when(Boolean(tint), (el) => el.bg(tint))
      .child(div().w(3).flex_none().self_stretch().when(Boolean(mark), (el) => el.bg(mark)))
      .child(n == null ? num : num.id(`n-${i}`).cursor_pointer()
        .hover((el) => el.bg(`${t.accent}33`).text_color(t.accent))
        .on_click((_e, cx) => this.startDraft(url, path, side, n, cx)))
      .child(div().w(16).flex_none().text_color(mark ?? t.dim).child({ add: "+", del: "−", hunk: "", ctx: " " }[l.kind]))
      .child(div().flex_none().pr(16).text_color(hunk ? t.muted : t.foreground).child(hunk ? l.text || " " : this.code(t, l.text, lang, colors)));
  }

  // Pending comments and the open draft under a line.
  extras(t, s, url, path, l, i) {
    if (l.kind === "hunk") return [];
    const side = l.kind === "del" ? "LEFT" : "RIGHT";
    const n = side === "LEFT" ? l.oldNo : l.newNo;
    const at = (c) => c.path === path && c.side === side && c.line === n;
    // Sizes report zoomed; boxes fit the panel, not the widest line.
    const w = Math.max(200, Math.min(720, this.width / (settings().zoom || 1) - 24));
    const items = this.prs.get(url)?.threads?.items ?? [];
    const threads = [...threadsAt(items, path, side, n), ...(l.kind === "ctx" ? threadsAt(items, path, "LEFT", l.oldNo) : [])]
      .map((th) => card(t, s, th, this.open, w, "th", this.replies));
    const out = pendingFor(url).filter(at).map((c) =>
      h_flex().id(`p-${c.id}`).w(w).mx(10).my(5).p(9).gap(8).items_start().rounded(rad(s, 8)).border(1).border_color(t.border).bg(t.popover)
        .child(v_flex().flex_1().min_w(0).gap(5)
          .child(h_flex().gap(8).items_center()
            .child(div().px(6).py(1).rounded(rad(s, 5)).bg(`${t.working}22`).text_size(10.5).text_color(t.working).child(label(s, "Pending")))
            .child(div().text_size(11).text_color(t.dim).child(`${side === "LEFT" ? "old" : "new"} line ${n}`)))
          .child(div().whitespace_normal().text_size(12).child(TextView.markdown(`pb-${c.id}`, c.body))))
        .child(div().id(`pd-${c.id}`).p(3).rounded(rad(s, 5)).hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => { setPendingFor(url, pendingFor(url).filter((x) => x.id !== c.id)); cx.notify(); })
          .child(svg(`${ICONS}/x.svg`).size(13).text_color(t.muted))));
    const d = this.draft;
    if (d && d.url === url && at(d)) {
      out.push(v_flex().id(`draft-${i}`).w(w).mx(10).my(5).p(9).gap(7).rounded(rad(s, 8)).border(1).border_color(t.accent).bg(t.popover).whitespace_normal()
        .child(div().text_size(11).text_color(t.dim).child(`Comment on ${side === "LEFT" ? "old" : "new"} line ${n}`))
        .child(div().id("draft-box").rounded(rad(s, 6)).border(1).border_color(t.border).p(6)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(d.input).h(60).text_size(12.5).text_color(t.foreground)))
        .when(Boolean(d.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(d.error ?? "")))
        .child(h_flex().gap(8).justify_end()
          .child(this.button(t, s, "draft-cancel", "Cancel", null, false, (_e, cx) => { this.draft = null; cx.notify(); }))
          .when(Boolean(this.agent), (el) => el.child(this.button(t, s, "draft-agent", this.sending === "draft" ? "Sending…" : "Send to agent", null, false, (_e, cx) => this.sendDraft(cx))))
          .child(this.button(t, s, "draft-add", "Add to review", null, true, (_e, cx) => this.addDraft(cx)))));
    }
    return [...threads, ...out];
  }

  // Runs of lines scroll sideways between the cards under them, so cards keep the panel's width.
  segments(rows) {
    const out = [];
    let run = [];
    const flush = (k) => {
      if (run.length) out.push(h_flex().id(`pr-x-${k}`).w_full().overflow_x_scrollbar().child(v_flex().flex_none().min_w_full().children(run)));
      run = [];
    };
    rows.forEach(([line, extras], k) => {
      run.push(line);
      if (extras.length) {
        flush(k);
        out.push(...extras);
      }
    });
    flush(rows.length);
    return out;
  }

  diff(t, s, url, file) {
    if (!file) return div().p(12).text_size(12).text_color(t.dim).child("Select a file to view its changes.");
    const lang = langFor(file.name);
    const colors = paletteFor(t.background);
    const all = file.lines.slice(0, MAX_LINES);
    const j = this.jump && this.jump.url === url && this.jump.path === file.name ? this.jump : null;
    const from = jumpIndex(all, j, (l, j) => l.kind !== "hunk" && (j.side === "LEFT" ? l.oldNo : l.newNo) === j.line);
    const lines = all.slice(from);
    const w = Math.max(200, Math.min(720, this.width / (settings().zoom || 1) - 24));
    const outdated = elsewhereBlock(t, s, elsewhere(this.prs.get(url)?.threads?.items ?? [], file.name), this.open, w, "ot", this.replies);
    return v_flex().id("pr-diff").flex_1().min_h(0).overflow_y_scrollbar()
      .when(from > 0, (el) => el.child(div().id("earlier").mx(10).mt(6).px(8).py(4).rounded(rad(s, 6)).text_size(11).text_color(t.accent).cursor_pointer()
        .hover((el) => el.bg(t.hover)).on_click((_e, cx) => { this.jump = null; cx.notify(); })
        .child(label(s, `Show ${from} earlier lines`))))
      .child(v_flex().py(4).font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5).line_height("20px")
        .children(this.segments(lines.map((l, k) => [this.line(t, s, l, k + from, url, file.name, lang, colors), this.extras(t, s, url, file.name, l, k + from)]))))
      .when(Boolean(outdated), (el) => el.child(outdated))
      .when(!file.lines.length, (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child("No text diff (binary, renamed or mode change).")))
      .when(file.lines.length > MAX_LINES, (el) => el.child(div().p(12).text_size(11.5).text_color(t.muted)
        .child(`${file.lines.length - MAX_LINES} more lines; Open review shows the rest on GitHub.`)));
  }

  render(cx) {
    const t = theme();
    const s = style();
    const now = this.focusedAgent();
    if (now && now !== this.agent) {
      this.agent = now;
      this.draft = null;
      this.picking = false;
      this.pickError = null;
    }
    if (this.agent && !terminals().some((x) => x.address === this.agent && x.state === "live")) this.agent = null;
    const url = this.agent ? this.urlFor(this.agent) : null;
    this.url = url;
    if (this.agent && !url && !this.tried.has(this.agent)) this.resolve(this.agent, cx);
    if (url) this.load(url, cx);
    const entry = url ? this.prs.get(url) : null;

    let body;
    if (!this.agent) body = div().p(12).text_size(12).text_color(t.dim).child("Focus an agent to see the PR it's reviewing.");
    else if (!url && !this.tried.has(this.agent)) body = div().p(12).text_size(12).text_color(t.muted)
      .child(div().loop("opacity", { from: 0.35, to: 1, period: 900 }).child("Looking for this agent's PR…"));
    else if (!url) body = this.picker(t, s, "No PR found for this agent. Paste one to show it here.");
    else if (entry?.error && !entry.files) body = div().p(12).text_size(12).text_color(t.blocked).child(entry.error);
    else if (!entry?.files) body = div().p(12).text_size(12).text_color(t.muted)
      .child(div().loop("opacity", { from: 0.35, to: 1, period: 900 }).child("Loading diff…"));
    else {
      const files = entry.files;
      if (!this.sel.has(url) && files.length) this.sel.set(url, files[0].name);
      const file = files.find((f) => f.name === this.sel.get(url));
      body = v_flex().flex_1().min_h(0).child(this.fileList(t, s, url, files)).child(this.diff(t, s, url, file));
    }

    return v_flex().id("pr-files").size_full().min_h(0).relative().overflow_hidden().rounded(rad(s, 10))
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(this.header(t, s, url, entry))
      .child(body)
      .when(s.name === "deck", (el) => el.children(brackets(t, t.accent, 10)));
  }
}
