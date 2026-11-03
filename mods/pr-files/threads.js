// A PR's review threads and your pending GitHub review, read-only, placed on the diff's lines; and the
// cards and comment list both diff views draw them with. GitHub only returns the viewer's own pending review.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, home } from "herdr";
import { label, rad, badge } from "./style.js";

const ICONS = "mods/workspace-chrome";
const QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes {
      id path line originalLine diffSide startLine isResolved isOutdated subjectType
      comments(first: 50) { nodes { id state author { login } body createdAt url } } } }
    reviews(states: PENDING, first: 1) { nodes { comments(first: 100) { nodes { id path line originalLine body createdAt url } } } }
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

// { items, pending: count of your pending review's comments, error }. Items: { kind: "thread" | "github-pending",
// id, path, side, line (null when outdated), originalLine, resolved, outdated, file (a file-level comment), comments }.
export async function loadThreads(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return { items: [], pending: 0, error: "Not a PR url" };
  const items = [];
  const seen = new Set();
  let review = null;
  let after = null;
  do {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${m[1]}`, "-F", `repo=${m[2]}`, "-F", `number=${m[3]}`];
    if (after) args.push("-F", `after=${after}`);
    const r = await exec("gh", args, { cwd: home() });
    if (r.code !== 0) return { items, pending: 0, error: r.stderr.trim() || "gh api graphql failed" };
    const pr = JSON.parse(r.stdout).data?.repository?.pullRequest;
    if (!pr) return { items, pending: 0, error: "PR not found" };
    review ??= pr.reviews.nodes[0] ?? null;
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
  return { items, pending: review?.comments.nodes.length ?? 0, error: null };
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

// One thread or pending-on-GitHub card. open: a Set of toggled keys the mod keeps; w: its width.
export function card(t, s, i, open, w, prefix) {
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
  const showReplies = open.has(repliesKey);
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
      .when(Boolean(first?.url), (el) => el.child(div().id(`${prefix}-gh-${i.id}`).text_size(10.5).text_color(t.dim).cursor_pointer()
        .hover((el) => el.text_color(t.accent)).on_click(() => exec("open", [first.url])).child(label(s, "Open on GitHub")))));
}

// The comments that didn't land on a shown line (outdated, file-level, or outside the diff), at a file's end.
export function elsewhereBlock(t, s, items, open, w, prefix) {
  if (!items.length) return null;
  return v_flex().py(4)
    .child(div().px(12).pt(4).text_size(10.5).text_color(t.dim).child(label(s, `Outdated · ${items.length}`)))
    .children(items.map((i) => card(t, s, i, open, w, prefix)));
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
