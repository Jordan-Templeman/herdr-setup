// A GitHub PR as a dialog: state, review, checks, branch, size, description. Opened by the
// inbox with props { url, key, action }; the footer starts or reopens its agent session.
// With props { terminal } instead it shows that agent's worktree changes (git reads only) and sends
// line comments to the agent's session as one message.

import { View, div, svg } from "gpui-kit";
import { sessionFor, statusOf, openSession, startSession } from "./session.js";
import { style, label, rad, badge, heading, brackets } from "./style.js";
import { tokens, langFor, PALETTES } from "./highlight.js";
import { parseDiff, splitRows } from "./diff.js";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, hc, spaces, run, theme, notify, props, closeOverlay, settings, home, appHome, shared, setShared, terminals, agents } from "herdr";
import * as fs from "fs/promises";

const ICONS = "mods/workspace-chrome";
const FIELDS = "number,title,state,isDraft,author,headRefName,baseRefName,labels,reviewDecision," +
  "statusCheckRollup,additions,deletions,changedFiles,body,updatedAt,createdAt,reviewRequests,latestReviews,mergeStateStatus";

const ago = (iso) => {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

const REVIEW = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
const REVIEWED = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "commented", DISMISSED: "dismissed" };

// Check runs report a conclusion, commit statuses a state.
function checks(rollup = []) {
  const word = (c) => c.conclusion || c.state || c.status;
  const failing = rollup.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(word(c)));
  const pending = rollup.filter((c) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING"].includes(word(c)));
  const passed = rollup.filter((c) => word(c) === "SUCCESS").length;
  return { failing: failing.map((c) => c.name || c.context), pending: pending.length, passed };
}

const MAX_LINES = 1500;
const PENDING = "pr-preview.pending";
const VIEWED = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    id
    files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } }
  } }
}`;

const parts = (url) => {
  const [, owner, repo, number] = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return { owner, repo, number };
};

const EVENTS = { review: "COMMENT", approve: "APPROVE", "request-changes": "REQUEST_CHANGES" };

// Comments waiting for the review, by PR url. Shared so they survive closing the dialog.
const pendingFor = (url) => (shared(PENDING) ?? {})[url] ?? [];
const setPendingFor = (url, list) => setShared(PENDING, { ...(shared(PENDING) ?? {}), [url]: list });

export default class PrPreview extends View {
  init(_props, cx) {
    this.s = style();
    this.pr = null;
    this.error = null;
    this.view = "overview";
    this.files = null;
    this.diffError = null;
    this.expanded = new Set();
    this.viewed = new Set();
    this.prId = null;
    this.layout = localStorage.getItem("diffLayout") ?? "unified";
    this.composing = false;
    this.draft = null;
    this.submitting = null;
    this.reviewError = null;
    this.reply = TextareaState.new({ placeholder: "Leave a comment (markdown)", rows: 4 });
    this.terminal = props()?.terminal ?? null;
    // Pending line comments live under the PR's url, or the agent's terminal.
    this.key = this.terminal ? `local:${this.terminal}` : props()?.url;
    if (this.terminal) this.loadLocal(cx);
    else this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const { url } = props() ?? {};
      if (!url) {
        this.error = "No pull request to show.";
        cx.notify();
        return;
      }
      const r = await exec("gh", ["pr", "view", url, "--json", FIELDS], { cwd: home() });
      if (r.code !== 0) this.error = r.stderr.trim() || "gh failed";
      else this.pr = JSON.parse(r.stdout);
      cx.notify();
    });
  }

  // The agent's changes against where its branch left the base: commits plus uncommitted and
  // untracked files. Read-only git (no optional locks), so the agent's worktree is never touched.
  loadLocal(cx) {
    this.view = "files";
    this.files = null;
    this.diffError = null;
    cx.spawn(async (cx) => {
      const term = terminals().find((x) => x.address === this.terminal);
      const cwd = term?.cwd;
      if (!cwd) {
        this.diffError = "That agent's terminal has closed.";
        return cx.notify();
      }
      const git = (...args) => exec("git", ["--no-optional-locks", "-C", cwd, ...args]);
      const top = await git("rev-parse", "--show-toplevel");
      if (top.code !== 0) {
        this.diffError = `${cwd} isn't a git checkout.`;
        return cx.notify();
      }
      const root = top.stdout.trim();
      // The base: the remote's default branch, else the first of these that exists.
      let base = null;
      const head = await git("rev-parse", "--abbrev-ref", "origin/HEAD");
      if (head.code === 0) base = head.stdout.trim();
      for (const b of ["origin/development", "origin/main", "origin/master", "development", "main", "master"]) {
        if (base) break;
        if ((await git("rev-parse", "--verify", "-q", b)).code === 0) base = b;
      }
      const mb = (base && (await git("merge-base", "HEAD", base)).stdout.trim()) || "HEAD";
      this.branch = (await git("branch", "--show-current")).stdout.trim();
      this.base = (base ?? "HEAD").replace(/^origin\//, "");
      const tracked = await exec("git", ["--no-optional-locks", "-C", root, "diff", "--no-color", "--no-ext-diff", mb]);
      const others = (await exec("git", ["--no-optional-locks", "-C", root, "ls-files", "--others", "--exclude-standard"])).stdout
        .split("\n").filter(Boolean).slice(0, 60);
      const added = await Promise.all(others.map((f) => exec("git", ["--no-optional-locks", "-C", root, "diff", "--no-color", "--no-index", "/dev/null", f])));
      if (tracked.code !== 0) this.diffError = tracked.stderr.trim() || "git diff failed";
      else {
        this.files = parseDiff([tracked.stdout, ...added.map((r) => r.stdout)].join("\n"));
        for (const f of this.files) this.expanded.add(f.name);
      }
      cx.notify();
    });
  }

  // Pending line comments as one message to the agent, which reads it like any prompt.
  sendComments(cx) {
    const pending = pendingFor(this.key);
    if (!pending.length) return;
    const note = this.reply.value().trim();
    const lines = pending.map((c, i) => `${i + 1}. \`${c.path}:${c.line}\`${c.side === "LEFT" ? " (removed line)" : ""}: ${c.body.replace(/\n+/g, " ")}`);
    const text = ["Review comments on your current changes, from the diff view. Work through each, then summarise what you changed.",
      note, ...lines].filter(Boolean).join("\n\n");
    this.submitting = "send";
    this.reviewError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", "--json", this.terminal, text]);
      this.submitting = null;
      if (r.code === 9) this.reviewError = "The agent is waiting on a prompt in its terminal. Answer it, then send again.";
      else if (r.code !== 0) this.reviewError = r.stderr.trim() || "Couldn't send.";
      else {
        notify({ title: `Sent ${pending.length} comment${pending.length === 1 ? "" : "s"} to the agent`, level: "info", timeout: 3000 });
        setPendingFor(this.key, []);
        this.reply.set_value("");
      }
      cx.notify();
    });
  }

  // Which files you've marked Viewed on GitHub (a file that changed since counts as unviewed).
  async loadViewed() {
    const { owner, repo, number } = parts(props().url);
    let after = null;
    do {
      const args = ["api", "graphql", "-f", `query=${VIEWED}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${number}`];
      if (after) args.push("-F", `after=${after}`);
      const r = await exec("gh", args, { cwd: home() });
      if (r.code !== 0) return;
      const pr = JSON.parse(r.stdout).data.repository.pullRequest;
      this.prId = pr.id;
      for (const f of pr.files.nodes) if (f.viewerViewedState === "VIEWED") this.viewed.add(f.path);
      after = pr.files.pageInfo.hasNextPage ? pr.files.pageInfo.endCursor : null;
    } while (after);
  }

  toggleViewed(path, cx) {
    if (!this.prId) return;
    const on = !this.viewed.has(path);
    on ? this.viewed.add(path) : this.viewed.delete(path);
    on ? this.expanded.delete(path) : this.expanded.add(path);
    cx.notify();
    cx.spawn(async (cx) => {
      const mutation = on ? "markFileAsViewed" : "unmarkFileAsViewed";
      const r = await exec("gh", ["api", "graphql", "-f",
        `query=mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`,
        "-F", `id=${this.prId}`, "-F", `path=${path}`], { cwd: home() });
      if (r.code !== 0) {
        on ? this.viewed.delete(path) : this.viewed.add(path);
        notify({ title: "Couldn't update Viewed", body: r.stderr.trim(), level: "error", timeout: 4000 });
      }
      cx.notify();
    });
  }

  showFiles(cx) {
    this.view = "files";
    cx.notify();
    if (this.files || this.diffError) return;
    cx.spawn(async (cx) => {
      const [r] = await Promise.all([exec("gh", ["pr", "diff", props().url], { cwd: home() }), this.loadViewed()]);
      if (r.code !== 0) this.diffError = r.stderr.trim() || "gh failed";
      else {
        this.files = parseDiff(r.stdout);
        for (const f of this.files) if (!this.viewed.has(f.name)) this.expanded.add(f.name);
      }
      cx.notify();
    });
  }

  // A line number that starts a comment on that line. side: LEFT (old) or RIGHT (new).
  num(t, n, path, side, id) {
    const cell = div().w(40).flex_none().px(6).text_color(t.dim).child(n == null ? "" : String(n));
    if (n == null || !path) return cell;
    return cell.id(`n-${id}-${side}`).cursor_pointer()
      .hover((s) => s.bg(`${t.accent}33`).text_color(t.accent))
      .on_click((_e, cx) => this.startDraft(path, side, n, cx));
  }

  // A line of code as colored spans, in the file's language when it's one we know.
  code(t, text, path) {
    const lang = path && langFor(path);
    if (!lang || !text) return div().child(text || " ");
    const colors = PALETTES[settings().dark ? "dark" : "light"];
    return h_flex().children(tokens(text, lang).map((tok) =>
      div().text_color(tok.kind ? colors[tok.kind] : t.foreground).child(tok.text)));
  }

  diffLine(t, l, i, mono, path) {
    const tint = { add: `${t.ansi2}26`, del: `${t.ansi1}26`, hunk: `${t.accent}14` }[l.kind];
    const sign = { add: "+", del: "−", hunk: "", ctx: " " }[l.kind];
    const hunk = l.kind === "hunk";
    return h_flex().id(`l-${i}`).min_w_full().flex_none().items_start().font_family(mono).text_size(11.5).whitespace_nowrap()
      .when(Boolean(tint), (el) => el.bg(tint))
      .child(this.num(t, hunk ? null : l.oldNo, path, "LEFT", i))
      .child(this.num(t, hunk ? null : l.newNo, path, "RIGHT", i))
      .child(div().w(14).flex_none().text_color(t.dim).child(sign))
      .child(div().flex_none().pr(16).text_color(hunk ? t.muted : t.foreground).child(hunk ? (l.text || " ") : this.code(t, l.text, path)));
  }

  splitSide(t, l, side, mono, path, i) {
    const tint = !l ? t.surface : { add: `${t.ansi2}26`, del: `${t.ansi1}26` }[l.kind];
    const n = l && (side === "LEFT" ? l.oldNo : l.newNo);
    return h_flex().flex_1().min_w(0).overflow_hidden().items_start()
      .when(Boolean(tint), (el) => el.bg(tint))
      .child(this.num(t, n, path, side, i))
      .child(div().w(14).flex_none().text_color(t.dim).child(!l ? "" : { add: "+", del: "−" }[l.kind] ?? " "))
      .child(div().flex_1().min_w(0).overflow_hidden().pr(8).text_color(t.foreground).child(l ? this.code(t, l.text, path) : ""));
  }

  splitRow(t, row, i, mono, path) {
    if (row.hunk) return this.diffLine(t, row.hunk, i, mono, null);
    return h_flex().id(`s-${i}`).w_full().font_family(mono).text_size(11.5).whitespace_nowrap()
      .child(this.splitSide(t, row.left, "LEFT", mono, path, i))
      .child(div().w(1).flex_none().self_stretch().bg(t.border))
      .child(this.splitSide(t, row.right, "RIGHT", mono, path, i));
  }

  startDraft(path, side, line, cx) {
    this.draft = { path, side, line, input: TextareaState.new({ placeholder: "Comment on this line (markdown)", rows: 3 }) };
    cx.notify();
  }

  addDraft(cx) {
    const body = this.draft.input.value().trim();
    if (!body) return;
    const { path, side, line } = this.draft;
    setPendingFor(this.key, [...pendingFor(this.key), { id: `${Date.now()}`, path, side, line, body }]);
    this.draft = null;
    cx.notify();
  }

  // Pending comments and the open draft that belong under a line; at(c) says whether c is on it.
  extras(t, path, at, i) {
    const out = pendingFor(this.key).filter((c) => c.path === path && at(c)).map((c) =>
      h_flex().id(`p-${c.id}`).max_w(760).mx(12).my(6).p(10).gap(10).items_start().rounded(rad(this.s, 8)).border(1).border_color(t.border).bg(t.popover)
        .child(v_flex().flex_1().min_w(0).gap(6)
          .child(h_flex().gap(8).items_center()
            .child(div().px(6).py(1).rounded(rad(this.s, 5)).bg(`${t.working}22`).text_size(10.5).text_color(t.working).child(label(this.s, "Pending")))
            .child(div().text_size(11).text_color(t.dim).child(`${c.side === "LEFT" ? "old" : "new"} line ${c.line}`)))
          .child(TextView.markdown(`pb-${c.id}`, c.body)))
        .child(div().id(`pd-${c.id}`).p(3).rounded(rad(this.s, 5)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { setPendingFor(this.key, pendingFor(this.key).filter((x) => x.id !== c.id)); cx.notify(); })
          .child(svg(`${ICONS}/x.svg`).size(13).text_color(t.muted))));
    const d = this.draft;
    if (d && d.path === path && at(d)) {
      out.push(v_flex().id(`draft-${i}`).max_w(760).mx(12).my(6).p(10).gap(8).rounded(rad(this.s, 8)).border(1).border_color(t.accent).bg(t.popover)
        .child(div().text_size(11).text_color(t.dim).child(`Comment on ${d.side === "LEFT" ? "old" : "new"} line ${d.line}`))
        .child(div().id("draft-box").rounded(rad(this.s, 6)).border(1).border_color(t.border).p(6)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(d.input).h(64).text_size(12.5).text_color(t.foreground)))
        .child(h_flex().gap(8).justify_end()
          .child(div().id("draft-cancel").px(10).py(5).rounded(rad(this.s, 6)).text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.draft = null; cx.notify(); }).child("Cancel"))
          .child(div().id("draft-add").px(10).py(5).rounded(rad(this.s, 6)).bg(t.solid).text_size(12).text_color(t.solid_foreground)
            .hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => this.addDraft(cx)).child(this.terminal ? "Add comment" : "Add to review"))));
    }
    return out;
  }

  toolbar(t) {
    const adds = this.files.reduce((n, f) => n + f.adds, 0);
    const dels = this.files.reduce((n, f) => n + f.dels, 0);
    const allOpen = this.files.every((f) => this.expanded.has(f.name));
    return h_flex().px(20).pt(12).gap(10).items_center()
      .child(div().text_size(12).text_color(t.muted).child(label(this.s, `${this.files.length} files`)))
      .child(div().text_size(12).text_color(t.ansi2).child(`+${adds}`))
      .child(div().text_size(12).text_color(t.ansi1).child(`−${dels}`))
      .when(!this.terminal, (el) => el.child(div().text_size(12).text_color(t.dim).child(label(this.s, `${this.files.filter((f) => this.viewed.has(f.name)).length} / ${this.files.length} viewed`))))
      .child(div().flex_1())
      .child(div().id("toggle-all").px(8).py(4).rounded(rad(this.s, 6)).text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (allOpen) this.expanded.clear();
          else for (const f of this.files) this.expanded.add(f.name);
          cx.notify();
        })
        .child(label(this.s, allOpen ? "Collapse all" : "Expand all")))
      .child(this.s.name !== "soft"
        ? this.segments(t, [["unified", "Unified"], ["split", "Split"]].map(([id, text]) =>
          [id, text, (cx) => { this.layout = id; localStorage.setItem("diffLayout", id); cx.notify(); }]), this.layout, "layout")
        : h_flex().p(3).gap(2).rounded(rad(this.s, 8)).bg(t.surface).children([["unified", "Unified"], ["split", "Split"]].map(([id, label]) =>
        div().id(`layout-${id}`).px(10).py(3).rounded(rad(this.s, 6)).text_size(12)
          .text_color(this.layout === id ? t.foreground : t.muted)
          .when(this.layout === id, (el) => el.bg(t.raised))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.layout = id; localStorage.setItem("diffLayout", id); cx.notify(); })
          .child(label))))
      .child(this.submitButton(t));
  }

  // A choice of views: a segmented control (soft), square cells (deck) or pills (lcars).
  segments(t, items, current, prefix) {
    const st = this.s;
    const lcars = st.name === "lcars";
    return h_flex().p(lcars || st.name === "deck" ? 0 : 3).gap(lcars ? 4 : 2).rounded(rad(st, 8))
      .when(st.name === "soft", (el) => el.bg(t.surface))
      .when(st.name === "deck", (el) => el.border(1).border_color(t.border).gap(0))
      .children(items.map(([id, text, go]) => {
        const on = current === id;
        return div().id(`${prefix}-${id}`).px(10).py(lcars ? 2 : st.name === "deck" ? 3 : 4).rounded(rad(st, 6)).text_size(st.name === "deck" ? 11 : 12)
          .text_color(on ? (st.name === "soft" ? t.foreground : t.background) : t.muted)
          .when(on, (el) => el.bg(st.name === "soft" ? t.raised : lcars ? t.ansi5 : t.accent))
          .when(lcars, (el) => el.font_family(st.head).text_size(15).when(!on, (el) => el.bg(t.raised)))
          .when(st.name === "deck", (el) => el.font_bold())
          .hover((s) => (on && st.name !== "soft" ? s : s.bg(t.hover)))
          .on_click((_e, cx) => go(cx))
          .child(label(st, text));
      }));
  }

  submitButton(t) {
    const n = pendingFor(this.key).length;
    if (this.terminal) {
      return h_flex().id("send-comments").gap(6).items_center().px(11).py(4).rounded(rad(this.s, 7))
        .bg(n ? t.solid : t.surface).when(!n, (el) => el.border(1).border_color(t.border))
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => this.sendComments(cx))
        .child(svg(`${ICONS}/terminal.svg`).size(13).text_color(n ? t.solid_foreground : t.muted))
        .child(div().text_size(12).text_color(n ? t.solid_foreground : t.muted)
          .child(label(this.s, this.submitting === "send" ? "Sending…" : n ? `Send to agent · ${n}` : "Click a line number to comment")));
    }
    return h_flex().id("submit-review").gap(6).items_center().px(11).py(4).rounded(rad(this.s, 7)).bg(t.solid)
      .hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => { this.composing = true; this.reviewError = null; cx.notify(); })
      .child(svg(`${ICONS}/square-pen.svg`).size(13).text_color(t.solid_foreground))
      .child(div().text_size(12).text_color(t.solid_foreground).child(label(this.s, n ? `Submit review · ${n}` : "Submit review")));
  }

  filesView(t) {
    if (this.diffError) return div().p(20).text_size(12.5).text_color(t.blocked).child(this.diffError);
    if (!this.files) return div().p(20).text_size(12.5).text_color(t.muted)
      .child(div().loop("opacity", { from: 0.35, to: 1, period: 900 }).child("Loading diff…"));
    const mono = settings().font_family ?? "Menlo";
    const split = this.layout === "split";
    return v_flex().flex_1().min_h(0).child(this.toolbar(t)).child(v_flex().id("files").flex_1().min_h(0).px(20).py(12).gap(8).overflow_y_scrollbar()
      .children(this.files.map((f, fi) => {
        const open = this.expanded.has(f.name);
        const shown = open ? f.lines.slice(0, MAX_LINES) : [];
        return v_flex().flex_none().rounded(rad(this.s, 8)).border(1).border_color(t.border)
          .child(h_flex().id(`f-${fi}`).px(12).py(8).gap(8).items_center().bg(t.surface)
            .when(open, (el) => el.border_b(1).border_color(t.border))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { open ? this.expanded.delete(f.name) : this.expanded.add(f.name); cx.notify(); })
            .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(13).text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(12).text_color(t.foreground).child(f.name))
            .child(div().text_size(11.5).text_color(t.ansi2).child(`+${f.adds}`))
            .child(div().text_size(11.5).text_color(t.ansi1).child(`−${f.dels}`))
            .when(!this.terminal, (el) => el.child(h_flex().id(`v-${fi}`).ml(6).gap(6).items_center().px(8).py(3).rounded(rad(this.s, 6)).border(1)
              .border_color(this.viewed.has(f.name) ? t.accent : t.border)
              .when(this.viewed.has(f.name), (el) => el.bg(`${t.accent}1a`))
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(f.name, cx); })
              .child(div().size(13).flex_none().rounded(rad(this.s, 3)).border(1)
                .border_color(this.viewed.has(f.name) ? t.accent : t.input)
                .when(this.viewed.has(f.name), (el) => el.bg(t.accent).flex().items_center().justify_center()
                  .child(svg(`${ICONS}/check.svg`).size(10).text_color(t.accent_foreground))))
              .child(div().text_size(11.5).text_color(this.viewed.has(f.name) ? t.foreground : t.muted).child(label(this.s, "Viewed"))))))
          .when(open && split, (el) => el.child(v_flex().py(4).overflow_hidden()
            .children(splitRows(shown).flatMap((row, i) => [
              this.splitRow(t, row, `${fi}-${i}`, mono, f.name),
              ...(row.hunk ? [] : this.extras(t, f.name, (c) => (c.side === "LEFT" ? row.left?.oldNo : row.right?.newNo) === c.line, `${fi}-${i}`)),
            ]))))
          .when(open && !split, (el) => el.child(v_flex().id(`d-${fi}`).py(4).overflow_x_scrollbar()
            .children(shown.flatMap((l, i) => [
              this.diffLine(t, l, `${fi}-${i}`, mono, f.name),
              ...(l.kind === "hunk" ? [] : this.extras(t, f.name, (c) => (c.side === "LEFT" ? l.oldNo : l.newNo) === c.line, `${fi}-${i}`)),
            ]))))
          .when(open, (el) => el
            .when(f.lines.length > MAX_LINES, (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.muted)
              .child(`${f.lines.length - MAX_LINES} more lines${this.terminal ? "." : "; open Files changed on GitHub for the rest."}`))));
      })));
  }

  // kind: "comment" posts to the conversation; "review", "approve" and "request-changes" submit one
  // review carrying every pending inline comment.
  submit(kind, cx) {
    const body = this.reply.value().trim();
    const { url, key } = props();
    const pending = pendingFor(url);
    const needsBody = kind === "comment" || kind === "request-changes" || (kind === "review" && !pending.length);
    if (needsBody && !body) {
      this.reviewError = kind === "review" ? "Write a summary or add a comment on a line first." : "Write something first.";
      cx.notify();
      return;
    }
    this.submitting = kind;
    this.reviewError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      if (kind === "comment") {
        r = await exec("gh", ["pr", "comment", url, "--body", body], { cwd: home() });
      } else {
        const [, owner, repo, number] = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        const review = { event: EVENTS[kind], comments: pending.map(({ path, line, side, body }) => ({ path, line, side, body })) };
        if (body) review.body = body;
        // Hidden, so saving it doesn't reload the mod.
        const file = `${appHome()}/mods/pr-preview/.review.json`;
        await fs.writeFile(file, JSON.stringify(review));
        r = await exec("gh", ["api", "-X", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", file], { cwd: home() });
      }
      this.submitting = null;
      if (r.code !== 0) this.reviewError = r.stderr.trim() || r.stdout.trim() || "gh failed";
      else {
        const done = { comment: "Comment posted", review: "Review submitted", approve: "Approved", "request-changes": "Changes requested" }[kind];
        notify({ title: done, body: key, level: "info", timeout: 3000 });
        if (kind !== "comment") setPendingFor(url, []);
        this.reply.set_value("");
        this.composing = false;
        this.load(cx);
      }
      cx.notify();
    });
  }

  composer(t, button) {
    const busy = Boolean(this.submitting);
    const act = (id, icon, label, primary, kind) => button(id, icon, this.submitting === kind ? "Sending…" : label, primary,
      (_e, cx) => { if (!busy) this.submit(kind, cx); });
    return v_flex().px(20).py(12).gap(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(div().id("reply").rounded(rad(this.s, 8)).border(1).border_color(t.border).bg(t.popover).p(8)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.reply).h(96).text_size(12.5).text_color(t.foreground)))
      .when(Boolean(this.reviewError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.reviewError)))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11.5).text_color(t.dim).child(pendingFor(props().url).length
          ? `Review includes ${pendingFor(props().url).length} line comment${pendingFor(props().url).length === 1 ? "" : "s"} · posts as you`
          : "Click a line number in Files changed to comment on it · posts as you"))
        .child(div().flex_1())
        .child(act("comment", "square-pen", "Comment", false, "comment"))
        .child(act("review", "layers", "Comment as review", false, "review"))
        .child(act("request-changes", "x", "Request changes", false, "request-changes"))
        .child(act("approve", "circle-check", "Approve", true, "approve")));
  }

  copyLink(t, url, mod) {
    return h_flex().id("copy-link").gap(5).items_center().px(8).py(4).rounded(rad(this.s, 6))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.write_to_clipboard(url);
        this.copied = true;
        cx.notify();
        cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
      })
      .child(svg(this.copied ? `${ICONS}/check.svg` : `mods/${mod}/link.svg`).size(13).text_color(this.copied ? t.done : t.muted))
      .child(div().text_size(11.5).text_color(this.copied ? t.done : t.muted).child(label(this.s, this.copied ? "Copied" : "Copy link")));
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Footer action: back to the item's session, else its start action (from the inbox), else none.
  sessionButton(button) {
    const { key, url, action } = props() ?? {};
    const session = sessionFor(key);
    if (session) {
      const status = statusOf(session);
      return button("session", "terminal", status ? `Open session · ${status}` : "Open session", true,
        () => { openSession(session); this.close(); });
    }
    if (action) return button("start", "terminal", action.label, true, (_e, cx) => {
      // Closing ends this dialog's tasks, so close only once the session is up and its tab named.
      cx.spawn(async () => {
        await startSession(key, action.prompt, url);
        this.close();
      });
    });
    return null;
  }


  field(t, name, value) {
    if (!value) return null;
    const soft = this.s.name === "soft";
    return h_flex().gap(12).items_start()
      .child(div().w(84).flex_none().text_size(soft ? 12 : 10.5).text_color(t.dim).when(!soft, (el) => el.pt(1)).child(label(this.s, name)))
      .child(typeof value === "string" ? div().flex_1().text_size(12.5).text_color(t.foreground).child(value) : value);
  }

  pill(text, color) {
    if (this.s.name !== "soft") return badge(this.s, theme(), text, color);
    return div().px(8).py(2).rounded(rad(this.s, 6)).bg(`${color}22`).text_size(11).text_color(color).child(text);
  }

  // The agent's worktree changes: header, the diff with line comments, and a note to send with them.
  renderLocal(t, st) {
    const agent = agents().find((a) => a.address === this.terminal);
    const name = agent?.title || agent?.tab_name || this.terminal;
    const header = h_flex().px(20).py(12).gap(10).items_center().border_b(1).border_color(t.border)
      .child(st.name === "soft" ? div().text_size(12).text_color(t.muted).child("Agent changes") : heading(st, t, "Agent changes", st.name === "lcars" ? "07-dif" : "07.dif"))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(name))
      .when(Boolean(this.branch), (el) => el.child(this.pill(`${this.branch} → ${this.base}`, t.muted)))
      .child(div().id("refresh").px(8).py(4).rounded(rad(st, 6)).text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.loadLocal(cx)).child(label(st, "Refresh")))
      .child(div().id("close").p(4).rounded(rad(st, 6)).hover((s) => s.bg(t.hover))
        .on_click(() => this.close())
        .child(svg(`${ICONS}/x.svg`).size(15).text_color(t.muted)));
    const empty = this.files && this.files.length === 0;
    const n = pendingFor(this.key).length;
    const note = n > 0 && v_flex().px(20).py(10).gap(6).border_t(1).border_color(t.border).bg(t.surface)
      .child(div().id("note").rounded(rad(st, 8)).border(1).border_color(t.border).bg(t.popover).p(8)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.reply).h(48).text_size(12.5).text_color(t.foreground)))
      .when(Boolean(this.reviewError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.reviewError)))
      .child(div().text_size(11.5).text_color(t.dim).child(`An optional note goes above your ${n} line comment${n === 1 ? "" : "s"}; nothing touches git or GitHub.`));
    return v_flex().size_full().relative().bg(t.popover).child(header)
      .child(empty ? div().p(20).text_size(12.5).text_color(t.muted).child("No changes on this branch yet.") : this.filesView(t))
      .when(Boolean(note), (el) => el.child(note))
      .when(st.name === "deck", (el) => el.children(brackets(t, t.accent, 14)));
  }

  render() {
    const t = theme();
    const st = (this.s = style());
    if (this.terminal) return this.renderLocal(t, st);
    const soft = st.name === "soft";
    const lcars = st.name === "lcars";
    const { key, url } = props() ?? {};
    const p = this.pr;

    const state = !p ? null
      : p.state === "MERGED" ? ["Merged", t.ansi5]
      : p.state === "CLOSED" ? ["Closed", t.blocked]
      : p.isDraft ? ["Draft", t.muted]
      : ["Open", t.done];
    const review = p && REVIEW[p.reviewDecision];
    const reviewColor = p?.reviewDecision === "APPROVED" ? t.done : p?.reviewDecision === "CHANGES_REQUESTED" ? t.blocked : t.muted;
    const c = p && checks(p.statusCheckRollup);

    const header = h_flex().px(lcars ? 12 : 20).py(12).gap(10).items_center().border_b(1).border_color(t.border)
      .when(soft, (el) => el.child(div().text_size(12).text_color(t.muted).child("Pull request")))
      .when(!soft, (el) => el.child(heading(st, t, "Pull request", lcars ? "08-git" : "08.git")))
      .child(div().text_size(12.5).font_semibold().text_color(soft ? t.foreground : t.accent).when(lcars, (el) => el.font_family(st.head).text_size(17))
        .child(key ?? ""))
      .when(Boolean(state), (el) => el.child(this.pill(state[0], state[1])))
      .when(Boolean(review), (el) => el.child(this.pill(review, reviewColor)))
      .when(p?.mergeStateStatus === "BEHIND", (el) => el.child(div().text_size(11.5).text_color(t.dim).child(label(st, "Behind base"))))
      .when(!lcars, (el) => el.child(div().flex_1()))
      .when(Boolean(url), (el) => el.child(this.copyLink(t, url, "pr-preview")))
      .when(Boolean(p), (el) => el.child(this.segments(t, [
        ["overview", "Overview", (cx) => { this.view = "overview"; cx.notify(); }],
        ["files", `Files changed ${p.changedFiles}`, (cx) => this.showFiles(cx)],
      ], this.view, "view")))
      .child(div().id("close").p(4).rounded(rad(this.s, 6)).hover((s) => s.bg(t.hover))
        .on_click(() => this.close())
        .child(svg(`${ICONS}/x.svg`).size(15).text_color(t.muted)));

    let body;
    if (this.error) body = div().p(20).text_size(12.5).text_color(t.blocked).child(this.error);
    else if (!p) body = div().p(20).text_size(12.5).text_color(t.muted)
      .child(div().loop("opacity", { from: 0.35, to: 1, period: 900 }).child("Loading pull request…"));
    else if (this.view === "files") body = this.filesView(t);
    else {
      const reviewers = [
        ...(p.latestReviews ?? []).map((r) => `${r.author?.login} ${REVIEWED[r.state] ?? r.state?.toLowerCase()}`),
        ...(p.reviewRequests ?? []).map((r) => `${r.login ?? r.name ?? r.slug} pending`),
      ].join(" · ");
      const checkLine = h_flex().flex_1().gap(10).flex_wrap().text_size(12.5)
        .child(div().text_color(t.done).child(`${c.passed} passed`))
        .when(c.failing.length > 0, (el) => el.child(div().text_color(t.blocked).child(`${c.failing.length} failing: ${c.failing.join(", ")}`)))
        .when(c.pending > 0, (el) => el.child(div().text_color(t.working).child(`${c.pending} pending`)));
      const size = h_flex().gap(6).text_size(12.5)
        .child(div().text_color(t.done).child(`+${p.additions}`))
        .child(div().text_color(t.blocked).child(`−${p.deletions}`))
        .child(div().text_color(t.muted).child(`in ${p.changedFiles} files`));
      const description = (p.body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trim();

      body = v_flex().id("body").flex_1().min_h(0).px(20).py(16).gap(16).overflow_y_scrollbar()
        .child(div().text_size(18).font_semibold().text_color(t.foreground).when(lcars, (el) => el.font_family(st.head).text_size(24)).child(p.title))
        .child(v_flex().gap(7).children([
          this.field(t, "Author", p.author?.name ? `${p.author.name} (${p.author.login})` : p.author?.login),
          this.field(t, "Branch", `${p.headRefName} → ${p.baseRefName}`),
          this.field(t, "Reviews", reviewers),
          this.field(t, "Checks", (p.statusCheckRollup ?? []).length ? checkLine : null),
          this.field(t, "Changes", size),
          this.field(t, "Updated", `${ago(p.updatedAt)} · opened ${ago(p.createdAt)}`),
          this.field(t, "Labels", (p.labels ?? []).map((l) => l.name).join(", ")),
        ].filter(Boolean)))
        .child(v_flex().gap(6)
          .child(soft ? div().text_size(12).text_color(t.dim).child("Description") : heading(st, t, "Description", null, lcars ? t.ansi5 : t.muted))
          .child(description
            ? TextView.markdown(`body-${key}`, description)
            : div().text_size(12.5).text_color(t.muted).child(label(st, "No description."))));
    }

    // LCARS fills every button: primary orange, the rest lilac.
    const button = (id, icon, text, primary, onClick) =>
      h_flex().id(id).gap(6).items_center().px(12).py(lcars ? 4 : 6).rounded(rad(this.s, 7))
        .when(primary, (el) => el.bg(t.solid))
        .when(!primary && lcars, (el) => el.bg(t.ansi5))
        .when(!primary && !lcars, (el) => el.border(1).border_color(t.border))
        .hover((s) => s.opacity(0.85))
        .on_click(onClick)
        .child(svg(`${ICONS}/${icon}.svg`).size(13).text_color(primary || lcars ? t.solid_foreground : t.foreground))
        .child(div().text_size(soft ? 12.5 : 11).when(!soft, (el) => el.font_bold()).when(lcars, (el) => el.font_family(st.head).text_size(16))
          .text_color(primary || lcars ? t.solid_foreground : t.foreground).child(label(st, text)));

    const footer = h_flex().px(20).py(12).gap(8).justify_end().border_t(1).border_color(t.border)
      .when(Boolean(p), (el) => el.child(button("review", this.composing ? "chevron-down" : "square-pen",
        this.composing ? "Hide review" : pendingFor(url).length ? `Submit review · ${pendingFor(url).length} pending` : "Submit review", pendingFor(url).length > 0 && !this.composing, (_e, cx) => { this.composing = !this.composing; this.reviewError = null; cx.notify(); })))
      .child(div().flex_1())
      .child(button("open", "git-branch", "Open on GitHub", false, () => { exec("open", [url]); this.close(); }))
      .children([this.sessionButton(button)].filter(Boolean));

    return v_flex().size_full().relative().bg(t.popover).child(header).child(body)
      .when(this.composing && Boolean(p), (el) => el.child(this.composer(t, button)))
      .child(footer)
      .when(st.name === "deck", (el) => el.children(brackets(t, t.accent, 14)));
  }
}
