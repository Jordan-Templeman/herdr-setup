// A PR's review threads and your pending GitHub review, placed on the diff's lines; the cards and comment
// list both diff views draw them with; and the GitHub writes (replies, adding to the pending review).
// GitHub only returns the viewer's own pending review.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, home, appHome, shared, notify } from "herdr";
import * as fs from "fs/promises";
import { label, rad, badge } from "./style.js";
import { lineNote } from "./diff.js";
import { sendToAgent, agentName } from "./session.js";

const ICONS = "mods/workspace-chrome";
const QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    id
    reviewThreads(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes {
      id path line originalLine diffSide startLine isResolved isOutdated subjectType
      comments(first: 50) { nodes { id state author { login } body createdAt url } } } }
    reviews(states: PENDING, first: 1) { nodes { id comments(first: 100) { nodes { id path line originalLine body createdAt url } } } }
  } }
}`;

export const ago = (iso) => {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

const comment = (c) => ({ id: c.id, author: c.author?.login ?? "you", body: c.body ?? "", createdAt: c.createdAt, url: c.url, pending: c.state === "PENDING" });

// { items, pending: count of your pending review's comments, prId, reviewId: your pending review's, error }. Items: { kind: "thread" | "github-pending",
// id, path, side, line (null when outdated), originalLine, resolved, outdated, file (a file-level comment), comments }.
export async function loadThreads(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return { items: [], pending: 0, error: "Not a PR url" };
  const items = [];
  const seen = new Set();
  let review = null;
  let prId = null;
  let after = null;
  do {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${m[1]}`, "-F", `repo=${m[2]}`, "-F", `number=${m[3]}`];
    if (after) args.push("-F", `after=${after}`);
    const r = await exec("gh", args, { cwd: home() });
    if (r.code !== 0) return { items, pending: 0, error: r.stderr.trim() || "gh api graphql failed" };
    const pr = JSON.parse(r.stdout).data?.repository?.pullRequest;
    if (!pr) return { items, pending: 0, error: "PR not found" };
    review ??= pr.reviews.nodes[0] ?? null;
    prId = pr.id;
    for (const th of pr.reviewThreads.nodes) {
      const comments = th.comments.nodes.map(comment);
      for (const c of comments) seen.add(c.id);
      items.push({
        kind: comments.length && comments.every((c) => c.pending) ? "github-pending" : "thread",
        id: th.id, path: th.path, side: th.diffSide ?? "RIGHT", line: th.line, originalLine: th.originalLine,
        resolved: th.isResolved, outdated: th.isOutdated, file: th.subjectType === "FILE", comments,
      });
    }
    after = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
  } while (after);
  // Pending comments GitHub didn't list under a thread.
  for (const c of review?.comments.nodes ?? []) {
    if (seen.has(c.id)) continue;
    items.push({ kind: "github-pending", id: c.id, path: c.path, side: "RIGHT", line: c.line, originalLine: c.originalLine,
      resolved: false, outdated: c.line == null, file: false, comments: [{ ...comment(c), pending: true }] });
  }
  return { url, items, pending: review?.comments.nodes.length ?? 0, prId, reviewId: review?.id ?? null, error: null };
}

// With shared "pr-preview.dryRun" on, GitHub writes go to inspect/gh-dry-run.log instead of running.
const DRY_RUN = "pr-preview.dryRun";
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

export async function ghWrite(args, note = "") {
  if (!shared(DRY_RUN)) return exec("gh", args, { cwd: home() });
  const dir = `${appHome()}/inspect`;
  const file = `${dir}/gh-dry-run.log`;
  await fs.mkdir(dir, { recursive: true });
  const old = (await fs.exists(file)) ? await fs.readFile(file, "utf8") : "";
  await fs.writeFile(file, `${old}# ${new Date().toISOString()}\ngh ${args.map(quote).join(" ")}\n${note && `${note}\n`}\n`);
  return { code: 0, stdout: "", stderr: "", dry: true };
}

// Strings go raw (-f), so a body starting with @ isn't read as a file; numbers typed (-F).
async function mutate(query, vars) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v != null) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = await ghWrite(args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || "gh api graphql failed");
  return r.dry ? null : JSON.parse(r.stdout).data;
}

const START_REVIEW = `mutation($pr: ID!) { addPullRequestReview(input: { pullRequestId: $pr }) { pullRequestReview { id } } }`;
const REPLY = `mutation($thread: ID!, $body: String!, $review: ID) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body, pullRequestReviewId: $review }) { comment { id } } }`;
const ADD_THREAD = `mutation($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, line: $line, side: $side, body: $body }) { thread { id } } }`;
const SUBMIT = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) { pullRequestReview { id } } }`;

// Your pending review's id, starting one (no event, so it stays pending) when there's none.
async function pendingReview(data) {
  if (data.reviewId) return data.reviewId;
  const out = await mutate(START_REVIEW, { pr: data.prId });
  return out?.addPullRequestReview.pullRequestReview.id ?? "DRY_RUN_NEW_REVIEW_ID";
}

// toReview: into your pending review, else posted now.
export async function replyTo(data, threadId, body, toReview) {
  const review = toReview ? await pendingReview(data) : null;
  await mutate(REPLY, { thread: threadId, body, review });
}

// Adds line comments to your pending review, then submits it. added(c) runs as each one lands.
export async function submitPending(reviewId, comments, event, body, added) {
  for (const c of comments) {
    await mutate(ADD_THREAD, { review: reviewId, path: c.path, line: c.line, side: c.side ?? "RIGHT", body: c.body });
    added(c);
  }
  await mutate(SUBMIT, { review: reviewId, event, body: body || null });
}

// Reply boxes on thread cards, per thread id, kept while the view lives. data() is the PR's threads,
// reload(cx) fetches them again, agent() the PR's agent session (or null), files() the parsed diff.
export class Replies {
  constructor({ data, reload, agent, files }) {
    this.boxes = new Map();
    this.data = data;
    this.reload = reload;
    this.agent = agent;
    this.files = files;
  }

  // The reply, with the thread's code and opening comment, to the agent's chat.
  toAgent(i, cx) {
    const box = this.boxes.get(i.id);
    const body = box?.input.value().trim();
    const address = this.agent();
    if (!box || box.busy || !address) return;
    if (!body) {
      box.error = "Write a reply first.";
      return cx.notify();
    }
    const first = i.comments[0];
    const quote = first ? `> ${first.author}: ${first.body.slice(0, 400).replace(/\n/g, "\n> ")}` : "";
    const note = lineNote(this.files(), { path: i.path, side: i.side, line: i.line ?? i.originalLine, body: [quote, body].filter(Boolean).join("\n\n") });
    box.busy = "agent";
    box.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      box.error = await sendToAgent(address, `On ${this.data()?.url}, a review thread at ${note}`);
      box.busy = null;
      if (!box.error) {
        this.boxes.delete(i.id);
        notify({ title: `Sent to ${agentName(address)}`, level: "info", timeout: 3000 });
      }
      cx.notify();
    });
  }

  open(id, cx) {
    const box = this.boxes.get(id) ?? { input: TextareaState.new({ placeholder: "Reply (markdown)", rows: 3 }), busy: null, error: null };
    box.shown = true;
    this.boxes.set(id, box);
    cx.notify();
  }

  close(id, cx) {
    this.boxes.delete(id);
    cx.notify();
  }

  send(id, toReview, cx) {
    const box = this.boxes.get(id);
    const body = box?.input.value().trim();
    const data = this.data();
    if (!box || box.busy || !data) return;
    if (!body) {
      box.error = "Write a reply first.";
      return cx.notify();
    }
    box.busy = toReview ? "review" : "now";
    box.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await replyTo(data, id, body, toReview);
        this.boxes.delete(id);
        this.reload(cx);
      } catch (e) {
        box.error = String(e?.message ?? e);
      }
      box.busy = null;
      cx.notify();
    });
  }
}

// Marks which items sit on a line the diff shows; the rest go to their file's Outdated list.
export function place(items, files) {
  const lines = new Map(files.map((f) => [f.name, new Set(f.lines.flatMap((l) =>
    l.kind === "hunk" ? [] : [l.oldNo != null && `LEFT:${l.oldNo}`, l.newNo != null && `RIGHT:${l.newNo}`].filter(Boolean)))]));
  for (const i of items) i.anchored = !i.outdated && !i.file && i.line != null && Boolean(lines.get(i.path)?.has(`${i.side}:${i.line}`));
  return items;
}

export const threadsAt = (items, path, side, n) => items.filter((i) => i.anchored && i.path === path && i.side === side && i.line === n);
export const elsewhere = (items, path) => items.filter((i) => !i.anchored && i.path === path);
export const fileCounts = (items, path) => {
  const mine = items.filter((i) => i.path === path);
  return { threads: mine.filter((i) => i.kind === "thread").length, pending: mine.filter((i) => i.kind === "github-pending").length };
};

// "3 threads · 2 pending on GitHub", or "" when there's neither.
export function summary(data) {
  if (!data) return "";
  const n = data.items.filter((i) => i.kind === "thread").length;
  return [n && `${n} thread${n === 1 ? "" : "s"}`, data.pending && `${data.pending} pending on GitHub`].filter(Boolean).join(" · ");
}

// Default collapsed when resolved or outdated; `open` holds the keys flipped from their default.
const isOpen = (open, key, closed) => !closed !== open.has(key);
const flip = (open, key) => (_e, cx) => { open.has(key) ? open.delete(key) : open.add(key); cx.stop_propagation(); cx.notify(); };

// A markdown body that collapses to a few lines when long.
function body(t, s, c, open, prefix) {
  const long = c.body.length > 480 || c.body.split("\n").length > 7;
  const key = `b:${c.id}`;
  const shown = !long || open.has(key);
  return v_flex().gap(3)
    .child(div().whitespace_normal().text_size(12).when(!shown, (el) => el.max_h(118).overflow_hidden())
      .child(TextView.markdown(`${prefix}-${c.id}`, c.body || "_(empty)_")))
    .when(long, (el) => el.child(div().id(`${prefix}-more-${c.id}`).text_size(11).text_color(t.accent).cursor_pointer()
      .on_click(flip(open, key)).child(label(s, shown ? "Show less" : "Show more"))));
}

function chip(t, s, text, color) {
  return s.name === "soft"
    ? div().flex_none().px(6).py(1).rounded(rad(s, 5)).bg(`${color}22`).text_size(10.5).text_color(color).child(text)
    : badge(s, t, text, color);
}

const where = (i) => i.file ? "file" : i.line != null ? `${i.side === "LEFT" ? "old" : "new"} line ${i.line}` : `was line ${i.originalLine ?? "?"}`;

// A thread's reply box: Reply now posts it, Add to review puts it in your pending review.
function replyBox(t, s, i, rep, prefix) {
  const box = rep.boxes.get(i.id);
  const act = (id, text, primary, go) => div().id(`${prefix}-${id}-${i.id}`).px(10).py(5).rounded(rad(s, 6)).text_size(12)
    .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((el) => el.opacity(0.85)))
    .when(!primary, (el) => el.border(1).border_color(t.border).text_color(t.foreground).hover((el) => el.bg(t.hover)))
    .on_click(go).child(label(s, text));
  if (!box) {
    return div().id(`${prefix}-reply-${i.id}`).text_size(11).text_color(t.accent).cursor_pointer()
      .hover((el) => el.opacity(0.8)).on_click((_e, cx) => rep.open(i.id, cx)).child(label(s, "Reply"));
  }
  return v_flex().gap(7)
    .child(div().id(`${prefix}-rbox-${i.id}`).rounded(rad(s, 6)).border(1).border_color(t.accent).bg(t.background).p(6)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Textarea.new(box.input).h(60).text_size(12.5).text_color(t.foreground)))
    .when(Boolean(box.error), (el) => el.child(div().whitespace_normal().text_size(11.5).text_color(t.blocked).child(box.error)))
    .child(h_flex().gap(8).justify_end()
      .child(act("rcancel", "Cancel", false, (_e, cx) => { if (!box.busy) rep.close(i.id, cx); }))
      .when(Boolean(rep.agent?.()), (el) => el.child(act("ragent", box.busy === "agent" ? "Sending…" : "Send to agent", false, (_e, cx) => rep.toAgent(i, cx))))
      .child(act("rlater", box.busy === "review" ? "Adding…" : "Add to review", false, (_e, cx) => rep.send(i.id, true, cx)))
      .child(act("rnow", box.busy === "now" ? "Posting…" : "Reply now", true, (_e, cx) => rep.send(i.id, false, cx))));
}

// One thread or pending-on-GitHub card. open: a Set of toggled keys the mod keeps; w: its width; rep: the
// view's Replies, for a Reply box.
export function card(t, s, i, open, w, prefix, rep) {
  const ghPending = i.kind === "github-pending";
  const dim = i.resolved || i.outdated;
  const expanded = isOpen(open, i.id, dim);
  const [first, ...replies] = i.comments;
  const color = ghPending ? t.ansi5 : t.accent;
  const head = h_flex().id(`${prefix}-h-${i.id}`).gap(7).items_center().min_w(0).cursor_pointer()
    .on_click(flip(open, i.id))
    .child(svg(`${ICONS}/chevron-${expanded ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.muted))
    .child(ghPending ? chip(t, s, label(s, "Pending on GitHub"), t.ansi5) : div().flex_none().text_size(11.5).font_semibold().text_color(t.foreground).child(first?.author ?? ""))
    .when(!ghPending && Boolean(first?.createdAt), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(first.createdAt))))
    .when(i.resolved, (el) => el.child(chip(t, s, label(s, "Resolved"), t.done)))
    .when(i.outdated, (el) => el.child(chip(t, s, label(s, "Outdated"), t.dim)))
    .when(!i.anchored, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(where(i))))
    .when(!expanded, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child((first?.body ?? "").split("\n")[0])))
    .when(replies.length > 0 && !expanded, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${replies.length}`)));
  const repliesKey = `r:${i.id}`;
  // Shown by default when one is pending, so a reply you just added is in view.
  const showReplies = open.has(repliesKey) !== replies.some((c) => c.pending);
  const reply = (c) => v_flex().gap(4).pl(10).border_l(2).border_color(c.pending ? t.ansi5 : t.border)
    .child(h_flex().gap(7).items_center()
      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(c.author))
      .child(div().text_size(10.5).text_color(t.dim).child(ago(c.createdAt)))
      .when(c.pending, (el) => el.child(chip(t, s, label(s, "Pending on GitHub"), t.ansi5))))
    .child(body(t, s, c, open, prefix));
  return v_flex().id(`${prefix}-${i.id}`).w(w).mx(10).my(5).p(9).gap(7).rounded(rad(s, 8)).border(1).border_l(3)
    .border_color(ghPending ? t.ansi5 : dim ? t.border : color).bg(t.popover)
    .when(dim, (el) => el.opacity(0.62))
    .child(head)
    .when(expanded && Boolean(first), (el) => el
      .child(body(t, s, first, open, prefix))
      .when(replies.length > 0, (el) => el
        .child(div().id(`${prefix}-rt-${i.id}`).text_size(11).text_color(t.accent).cursor_pointer().on_click(flip(open, repliesKey))
          .child(label(s, showReplies ? "Hide replies" : `${replies.length} repl${replies.length === 1 ? "y" : "ies"}`)))
        .when(showReplies, (el) => el.children(replies.map(reply))))
      .child(h_flex().gap(14).items_center()
        .when(Boolean(rep) && !rep?.boxes.has(i.id), (el) => el.child(replyBox(t, s, i, rep, prefix)))
        .when(Boolean(first?.url), (el) => el.child(div().id(`${prefix}-gh-${i.id}`).text_size(10.5).text_color(t.dim).cursor_pointer()
          .hover((el) => el.text_color(t.accent)).on_click(() => exec("open", [first.url])).child(label(s, "Open on GitHub"))))))
    .when(Boolean(rep?.boxes.has(i.id)), (el) => el.child(replyBox(t, s, i, rep, prefix)));
}

// The comments that didn't land on a shown line (outdated, file-level, or outside the diff), at a file's end.
export function elsewhereBlock(t, s, items, open, w, prefix, rep) {
  if (!items.length) return null;
  return v_flex().py(4)
    .child(div().px(12).pt(4).text_size(10.5).text_color(t.dim).child(label(s, `Outdated · ${items.length}`)))
    .children(items.map((i) => card(t, s, i, open, w, prefix, rep)));
}

// Every comment on the PR by file: your local pending ones, your pending GitHub review, then threads.
export function allComments(local, data) {
  const rows = [
    ...local.map((c) => ({ key: `l-${c.id}`, kind: "local", path: c.path, side: c.side, line: c.line, author: "you", body: c.body })),
    ...(data?.items ?? []).map((i) => ({ key: `g-${i.id}`, kind: i.kind, path: i.path, side: i.side, line: i.anchored ? i.line : null,
      was: i.originalLine, file: i.file, resolved: i.resolved, outdated: i.outdated, author: i.comments[0]?.author ?? "",
      body: i.comments[0]?.body ?? "", replies: i.comments.length - 1 })),
  ];
  const groups = new Map();
  for (const r of rows) groups.set(r.path, [...(groups.get(r.path) ?? []), r]);
  for (const list of groups.values()) list.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  return { total: rows.length, groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)) };
}

// The View comments list. onPick(row, cx) jumps to it.
export function commentList(t, s, all, onPick) {
  const kinds = { local: [label(s, "Pending"), t.working], "github-pending": [label(s, "On GitHub"), t.ansi5] };
  if (!all.total) return div().p(12).text_size(12).text_color(t.dim).child("No comments on this PR yet.");
  return v_flex().gap(8).children(all.groups.map(([path, rows], gi) => v_flex().gap(2)
    .child(div().px(6).truncate().text_size(11).text_color(t.muted).child(path))
    .children(rows.map((r) => {
      const [k, kc] = kinds[r.kind] ?? (r.resolved ? [label(s, "Resolved"), t.done] : r.outdated ? [label(s, "Outdated"), t.dim] : [label(s, "Open"), t.accent]);
      const at = r.file ? "file" : r.line != null ? `${r.side === "LEFT" ? "−" : ""}L${r.line}` : `was L${r.was ?? "?"}`;
      return h_flex().id(`cl-${gi}-${r.key}`).h(26).flex_none().px(6).gap(7).items_center().rounded(rad(s, 6)).cursor_pointer()
        .when(r.resolved || r.outdated, (el) => el.opacity(0.65))
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => onPick(r, cx))
        .child(div().w(64).flex_none().whitespace_nowrap().truncate().text_size(11).text_color(t.dim).child(at))
        .child(chip(t, s, k, kc))
        .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.foreground).child(r.author))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(r.body.split("\n")[0]))
        .when(r.replies > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${r.replies}`)));
    }))));
}

// Where a diff should start so `jump` (a line on a side) is near the top: an index into lines.
export function jumpIndex(lines, jump, at) {
  if (!jump) return 0;
  const i = jump.line == null ? -1 : lines.findIndex((l) => at(l, jump));
  return i < 0 ? (jump.line == null ? lines.length : 0) : Math.max(0, i - 6);
}
