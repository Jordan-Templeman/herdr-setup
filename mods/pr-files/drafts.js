// Replies an agent drafted for a PR (bin/herdr-draft), shown where they'll be posted: under their thread,
// on their line, or by the PR comment box. One file per PR in drafts/; the views watch the folder. Posting
// goes through threads.js (ghWrite), and a posted or discarded draft leaves the file.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { appHome, notify, watchFolder } from "herdr";
import * as fs from "fs/promises";
import { label, rad } from "./style.js";
import { ago, chip, replyTo, addThread, pendingReview, ghWrite, isDryRun, loadThreads, openLink } from "./threads.js";

export const draftsDir = () => `${appHome()}/drafts`;
const PR = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function draftFile(url) {
  const m = PR.exec(url ?? "");
  return m ? `${draftsDir()}/${m[1]}__${m[2]}__${m[3]}.json` : null;
}

export async function readDrafts(url) {
  const file = draftFile(url);
  if (!file || !(await fs.exists(file))) return [];
  try {
    const list = JSON.parse(await fs.readFile(file, "utf8")).drafts;
    return Array.isArray(list) ? list.filter((d) => d && d.id && typeof d.body === "string") : [];
  } catch {
    return [];
  }
}

// change(list) returns the new list; read fresh so a draft the CLI just added isn't lost. Empty removes the file.
export async function changeDrafts(url, change) {
  const file = draftFile(url);
  if (!file) return [];
  const next = change(await readDrafts(url));
  if (!next.length) {
    if (await fs.exists(file)) await fs.unlink(file);
  } else {
    await fs.mkdir(draftsDir(), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ pr: url, drafts: next }, null, 2)}\n`);
  }
  return next;
}

// "discussion_r123" from a comment link.
const frag = (u) => (u ?? "").split("#")[1] ?? "";

// What a draft is, given the PR's threads (and, when known, its diff and timeline):
// { kind: "thread" (a reply; thread) | "comment" (a reply to a PR comment) | "inline" (a new line comment;
// anchored when the diff shows its line) | "general" (a new PR comment) | "unplaced" (its thread or comment is gone) }.
export function classify(d, threads, files, timeline) {
  const f = frag(d.target);
  if (f.startsWith("discussion_r")) {
    const thread = (threads?.items ?? []).find((i) => i.comments.some((c) => frag(c.url) === f));
    return thread ? { kind: "thread", thread } : { kind: threads ? "unplaced" : "loading" };
  }
  if (f.startsWith("issuecomment-")) {
    if (!timeline) return { kind: "comment" };
    return timeline.items.some((it) => it.type === "comment" && frag(it.c?.url) === f) ? { kind: "comment" } : { kind: "unplaced" };
  }
  if (d.target) return { kind: "unplaced" };
  if (!d.path) return { kind: "general" };
  const file = files?.find((x) => x.name === d.path);
  const side = d.side ?? "RIGHT";
  const anchored = !files || Boolean(file?.lines.some((l) => l.kind !== "hunk" && (side === "LEFT" ? l.oldNo : l.newNo) === d.line));
  return { kind: anchored ? "inline" : "unplaced" };
}

// The drafts of the PR a view shows, kept fresh, with their cards and list. url() is the PR, data() its
// threads, files() its parsed diff, timeline() its Conversation (or null), reload(cx) refetches threads,
// prefill(body, cx) (optional) puts a body in the PR comment box.
export class Drafts {
  constructor({ url, data, files, timeline, reload, prefill }) {
    this.url = url;
    this.data = data;
    this.files = files ?? (() => null);
    this.timeline = timeline ?? (() => null);
    this.reload = reload;
    this.prefill = prefill ?? null;
    this.lists = new Map();
    this.edits = new Map();
    this.confirm = null;
    this.busy = null;
  }

  // Reads the current PR's drafts once, then again whenever the folder changes (cheap: a few small files).
  start(cx) {
    if (this.watching) return;
    this.watching = true;
    cx.spawn(async (cx) => {
      await fs.mkdir(draftsDir(), { recursive: true });
      for (;;) {
        await this.refresh();
        cx.notify();
        await watchFolder(draftsDir());
      }
    });
  }

  async refresh() {
    const urls = new Set([...this.lists.keys(), this.url()].filter(Boolean));
    for (const u of urls) this.lists.set(u, await readDrafts(u));
  }

  // Loads a PR's drafts the first time it's shown (pr-files changes PR with the agent).
  list(cx) {
    const u = this.url();
    if (!u) return [];
    if (!this.lists.has(u)) {
      this.lists.set(u, []);
      if (cx) cx.spawn(async (cx) => { this.lists.set(u, await readDrafts(u)); cx.notify(); });
    }
    return this.lists.get(u);
  }

  placed(cx) {
    const threads = this.data();
    return this.list(cx).map((d) => ({ d, ...classify(d, threads, this.files(), this.timeline()) }));
  }

  async change(fn, cx) {
    const u = this.url();
    this.lists.set(u, await changeDrafts(u, fn));
    cx.notify();
  }

  // Posts one draft; once it's on GitHub the draft leaves the file. A dry run logs it and keeps it.
  post(d, kind, how, cx) {
    if (this.busy) return;
    const data = this.data();
    const what = { now: "reply", review: "add to review", comment: "post comment" }[how];
    this.busy = { id: d.id, what };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (how === "comment") {
          const r = await ghWrite(["pr", "comment", this.url(), "--body", d.body]);
          if (r.code !== 0) throw new Error(r.stderr.trim() || "gh pr comment failed");
        } else if (kind.kind === "thread") await replyTo(data, kind.thread.id, d.body, how === "review");
        else await addThread(data, { path: d.path, line: d.line, side: d.side ?? "RIGHT", body: d.body });
        if (isDryRun()) notify({ title: `Dry run: ${what} logged`, body: "inspect/gh-dry-run.log", level: "info", timeout: 3000 });
        else {
          await this.change((list) => list.filter((x) => x.id !== d.id), cx);
          this.reload(cx);
        }
      } catch (e) {
        notify({ title: `Couldn't ${what}`, body: String(e?.message ?? e), level: "error", timeout: 5000 });
      }
      this.busy = null;
      cx.notify();
    });
  }

  // Every thread reply and line comment into your pending review (not submitted). The first click asks.
  postAll(cx) {
    if (this.busy) return;
    const go = this.placed(cx).filter((p) => p.kind === "thread" || p.kind === "inline");
    if (!go.length) return;
    if (this.confirm !== "all") {
      this.confirm = "all";
      cx.notify();
      cx.timer.after(4000, (cx) => { if (this.confirm === "all") this.confirm = null; cx.notify(); });
      return;
    }
    this.confirm = null;
    this.busy = { id: "all", what: "add to review" };
    cx.notify();
    cx.spawn(async (cx) => {
      let done = 0;
      try {
        // Fresh, in case the pending review was submitted or discarded on GitHub since this loaded.
        const fresh = await loadThreads(this.url()).catch(() => null);
        const data = { ...this.data(), reviewId: fresh?.reviewId ?? this.data()?.reviewId ?? null };
        data.reviewId = await pendingReview(data);
        for (const p of go) {
          if (p.kind === "thread") await replyTo(data, p.thread.id, p.d.body, true);
          else await addThread(data, { path: p.d.path, line: p.d.line, side: p.d.side ?? "RIGHT", body: p.d.body });
          done++;
          if (!isDryRun()) await this.change((list) => list.filter((x) => x.id !== p.d.id), cx);
        }
        notify({ title: isDryRun() ? `Dry run: ${done} logged` : `${done} added to your review`, body: isDryRun() ? "inspect/gh-dry-run.log" : "Submit it from Submit review",
          level: "info", timeout: 4000 });
      } catch (e) {
        notify({ title: `Added ${done} of ${go.length}; then couldn't`, body: String(e?.message ?? e), level: "error", timeout: 6000 });
      }
      if (!isDryRun()) this.reload(cx);
      this.busy = null;
      cx.notify();
    });
  }

  edit(d, cx) {
    this.edits.set(d.id, TextareaState.new({ value: d.body, rows: 4 }));
    cx.notify();
  }

  saveEdit(d, cx) {
    const body = this.edits.get(d.id)?.value().trim();
    if (!body) return;
    this.edits.delete(d.id);
    cx.spawn(async (cx) => this.change((list) => list.map((x) => (x.id === d.id ? { ...x, body } : x)), cx));
  }

  // The first click asks; a second within 4s removes it from the file.
  discard(d, cx) {
    if (this.confirm !== d.id) {
      this.confirm = d.id;
      cx.notify();
      cx.timer.after(4000, (cx) => { if (this.confirm === d.id) this.confirm = null; cx.notify(); });
      return;
    }
    this.confirm = null;
    cx.spawn(async (cx) => this.change((list) => list.filter((x) => x.id !== d.id), cx));
  }

  // Cards for the drafts replying in thread i.
  forThread(t, s, i, prefix) {
    return this.placed().filter((p) => p.kind === "thread" && p.thread.id === i.id).map((p) => draftCard(t, s, p, this, prefix));
  }

  // Cards for new line comments on a line; at(c) says whether c (path, side, line) is on it.
  inlineAt(t, s, path, at, prefix) {
    return this.placed().filter((p) => p.kind === "inline" && p.d.path === path && at({ ...p.d, side: p.d.side ?? "RIGHT" }))
      .map((p) => draftCard(t, s, p, this, prefix));
  }

  // Cards for replies to a PR comment (Conversation).
  forComment(t, s, c, prefix) {
    return this.placed().filter((p) => p.kind === "comment" && frag(p.d.target) === frag(c.url)).map((p) => draftCard(t, s, p, this, prefix));
  }

  // Drafts with nowhere to sit in this view: kinds (e.g. ["unplaced"], or with "comment" and "general"
  // where there's no Conversation). null when there are none.
  box(t, s, kinds, prefix, w) {
    const rest = this.placed().filter((p) => kinds.includes(p.kind));
    if (!rest.length) return null;
    const lost = rest.filter((p) => p.kind === "unplaced").length;
    const title = lost === rest.length ? `Unplaced drafts · ${lost}` : `Drafts for the conversation · ${rest.length}`;
    return v_flex().id(`${prefix}-drafts-box`).when(w != null, (el) => el.w(w)).gap(4).p(8).rounded(rad(s, 8)).border(1).border_color(`${t.ansi3}66`)
      .child(div().text_size(10.5).text_color(t.ansi3).child(label(s, title)))
      .when(lost > 0 && lost < rest.length, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${lost} can't find their thread`)))
      .children(rest.map((p) => draftCard(t, s, p, this, prefix)));
  }
}

const btn = (t, s, id, text, primary, go) => div().id(id).flex_none().px(10).py(4).rounded(rad(s, 6)).text_size(11.5)
  .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((el) => el.opacity(0.85)))
  .when(!primary, (el) => el.border(1).border_color(t.border).text_color(t.foreground).hover((el) => el.bg(t.hover)))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { cx.stop_propagation(); go(cx); }).child(label(s, text));

const where = (p) => p.kind === "thread" ? "reply"
  : p.kind === "inline" ? `new comment · ${p.d.side === "LEFT" ? "old" : "new"} line ${p.d.line}`
  : p.kind === "comment" ? "reply to a PR comment"
  : p.kind === "general" ? "new PR comment"
  : p.d.target ? "thread not found" : `${p.d.path}:${p.d.line} isn't in the diff`;

// One draft: what will be posted, and Reply now / Add to review / Post comment, Edit, Discard.
export function draftCard(t, s, p, ctl, prefix) {
  const { d } = p;
  const id = (k) => `${prefix}-dr${k}-${d.id}`;
  const edit = ctl.edits.get(d.id);
  const busy = ctl.busy && (ctl.busy.id === d.id || ctl.busy.id === "all") ? ctl.busy.what : null;
  const acts = [];
  if (p.kind === "thread") {
    acts.push(btn(t, s, id("n"), busy === "reply" ? "Posting…" : "Reply now", true, (cx) => ctl.post(d, p, "now", cx)));
    acts.push(btn(t, s, id("r"), busy === "add to review" ? "Adding…" : "Add to review", false, (cx) => ctl.post(d, p, "review", cx)));
  } else if (p.kind === "inline") {
    acts.push(btn(t, s, id("r"), busy ? "Adding…" : "Add to review", true, (cx) => ctl.post(d, p, "review", cx)));
  } else if (p.kind === "comment" || p.kind === "general") {
    acts.push(btn(t, s, id("c"), busy ? "Posting…" : "Post comment", true, (cx) => ctl.post(d, p, "comment", cx)));
    if (p.kind === "general" && ctl.prefill) acts.push(btn(t, s, id("p"), "Put in comment box", false, (cx) => ctl.prefill(d.body, cx)));
  }
  acts.push(btn(t, s, id("e"), "Edit", false, (cx) => ctl.edit(d, cx)));
  acts.push(btn(t, s, id("x"), ctl.confirm === d.id ? "Click again to discard" : "Discard", false, (cx) => ctl.discard(d, cx)));
  return v_flex().id(id("card")).mt(6).p(8).gap(6).rounded(rad(s, 8)).border(1).border_l(3).border_color(t.ansi3).bg(`${t.ansi3}10`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(h_flex().gap(7).items_center().min_w(0)
      .child(chip(t, s, label(s, `Draft · from ${d.agent || "agent"}`), t.ansi3))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(where(p)))
      .when(Boolean(d.createdAt), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(d.createdAt))))
      .when(Boolean(d.target) && p.kind === "unplaced", (el) => el.child(div().id(id("o")).flex_1().min_w(0).truncate().text_size(10.5).text_color(t.accent)
        .cursor_pointer().on_click((_e, cx) => cx.open_url(d.target)).child(d.target))))
    .child(edit
      ? div().id(id("ebox")).rounded(rad(s, 6)).border(1).border_color(t.accent).bg(t.background).p(6)
        .child(Textarea.new(edit).h(84).text_size(12.5).text_color(t.foreground))
      : div().whitespace_normal().text_size(12).child(TextView.markdown(id("b"), d.body).on_link_click((url, cx) => openLink(url, cx, ctl.url()))))
    .child(h_flex().gap(8).flex_wrap().items_center()
      .children(edit
        ? [btn(t, s, id("ec"), "Cancel", false, (cx) => { ctl.edits.delete(d.id); cx.notify(); }), btn(t, s, id("es"), "Save draft", true, (cx) => ctl.saveEdit(d, cx))]
        : acts));
}

// The Drafts list: where each goes, its first line, its agent; onPick(p, cx) jumps to it. Post all adds
// every thread reply and line comment to your pending review.
export function draftList(t, s, ctl, onPick) {
  const all = ctl.placed();
  if (!all.length) return div().p(12).text_size(12).text_color(t.dim).child("No drafts. Agents add them with bin/herdr-draft.");
  const n = all.filter((p) => p.kind === "thread" || p.kind === "inline").length;
  const at = (p) => {
    const i = p.thread;
    if (i) return `${i.path}:${i.anchored ? i.line : `was ${i.originalLine ?? "?"}`}`;
    if (p.d.path) return `${p.d.path}:${p.d.line}`;
    return p.kind === "unplaced" ? "not found" : "conversation";
  };
  return v_flex().gap(4)
    .when(n > 0, (el) => el.child(h_flex().px(6).pb(4).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Adds to your pending review; you submit it."))
      .child(btn(t, s, "dl-all", ctl.busy?.id === "all" ? "Adding…" : ctl.confirm === "all" ? `Click again: add ${n}` : `Post all as review · ${n}`, true, (cx) => ctl.postAll(cx)))))
    .children(all.map((p) => v_flex().id(`dl-${p.d.id}`).px(6).py(4).gap(2).rounded(rad(s, 6)).cursor_pointer()
      .hover((el) => el.bg(t.hover)).on_click((_e, cx) => onPick(p, cx))
      .child(h_flex().gap(7).items_center().min_w(0)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(p.kind === "unplaced" ? t.blocked : t.accent).child(at(p)))
        .child(div().flex_none().text_size(10.5).text_color(t.ansi3).child(p.d.agent || "agent")))
      .child(div().truncate().text_size(11.5).text_color(t.muted).child(p.d.body.split("\n")[0]))));
}
