// A PR's review threads and your pending GitHub review, placed on the diff's lines; the cards and comment
// list both diff views draw them with; and the GitHub writes (replies, adding to the pending review,
// resolving, editing and deleting comments). GitHub only returns the viewer's own pending review.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, home, appHome, shared, notify, openOverlay, settings } from "herdr";
import * as fs from "fs/promises";
import { label, rad, badge } from "./style.js";
import { lineNote, agentMessage, snippet } from "./diff.js";
import { sendToAgent, agentName } from "./session.js";
import { tokens, langFor, paletteFor } from "./highlight.js";

const ICONS = "mods/workspace-chrome";
const QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    id
    reviewThreads(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes {
      id path line originalLine diffSide startLine isResolved isOutdated subjectType viewerCanResolve viewerCanUnresolve
      comments(first: 50) { nodes { id state author { login } body createdAt url viewerDidAuthor } } } }
    reviews(states: PENDING, first: 1) { nodes { id comments(first: 100) { nodes { id path line originalLine body createdAt url viewerDidAuthor } } } }
  } }
}`;

export const ago = (iso) => {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

// kind: which GitHub object it is, for edits and deletes: review-comment, issue-comment, review or description.
export const comment = (c, kind = "review-comment") => ({ id: c.id, kind, author: c.author?.login ?? "you", body: c.body ?? "",
  createdAt: c.createdAt, url: c.url, pending: c.state === "PENDING", mine: Boolean(c.viewerDidAuthor) });

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
      const comments = th.comments.nodes.map((c) => comment(c));
      for (const c of comments) seen.add(c.id);
      items.push({
        kind: comments.length && comments.every((c) => c.pending) ? "github-pending" : "thread",
        id: th.id, path: th.path, side: th.diffSide ?? "RIGHT", line: th.line, originalLine: th.originalLine,
        resolved: th.isResolved, outdated: th.isOutdated, file: th.subjectType === "FILE", comments,
        canResolve: th.viewerCanResolve, canUnresolve: th.viewerCanUnresolve,
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

export const isDryRun = () => Boolean(shared(DRY_RUN));

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
export async function pendingReview(data) {
  if (data.reviewId) return data.reviewId;
  const out = await mutate(START_REVIEW, { pr: data.prId });
  return out?.addPullRequestReview.pullRequestReview.id ?? "DRY_RUN_NEW_REVIEW_ID";
}

const RESOLVE = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;
const UNRESOLVE = `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;
const EDIT = {
  "review-comment": `mutation($id: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id } } }`,
  "issue-comment": `mutation($id: ID!, $body: String!) { updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } } }`,
  review: `mutation($id: ID!, $body: String!) { updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { pullRequestReview { id } } }`,
};
// A submitted review can't be deleted, only its body edited.
const DELETE = {
  "review-comment": `mutation($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }`,
  "issue-comment": `mutation($id: ID!) { deleteIssueComment(input: { id: $id }) { clientMutationId } }`,
};

export const setResolved = (threadId, on) => mutate(on ? RESOLVE : UNRESOLVE, { thread: threadId });
export const editComment = (c, body) => mutate(EDIT[c.kind], { id: c.id, body });
export const deleteComment = (c) => mutate(DELETE[c.kind], { id: c.id });
export const canEdit = (c) => c.mine && Boolean(EDIT[c.kind]);
export const canDelete = (c) => c.mine && Boolean(DELETE[c.kind]);

// The code GitHub kept around an inline comment, for when the parsed diff doesn't have its line. Read-only.
export async function hunkFor(id) {
  const query = `query($id: ID!) { node(id: $id) { ... on PullRequestReviewComment { diffHunk } } }`;
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `id=${id}`], { cwd: home() });
  return r.code === 0 ? JSON.parse(r.stdout).data?.node?.diffHunk ?? null : null;
}

// What an inline comment is anchored to: GitHub's diff hunk (it ends at the comment's line) and its lines.
// Fetched only when a card away from its diff line opens, once per comment. Read-only.
const ANCHOR = `query($id: ID!) { node(id: $id) { ... on PullRequestReviewComment { diffHunk path line startLine originalLine originalStartLine outdated } } }`;
const anchors = new Map();

export async function anchorFor(id, run = (args) => exec("gh", args, { cwd: home() })) {
  const r = await run(["api", "graphql", "-f", `query=${ANCHOR}`, "-f", `id=${id}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "gh api graphql failed");
  return JSON.parse(r.stdout).data?.node ?? null;
}

function loadAnchor(id, cx) {
  if (anchors.has(id)) return;
  anchors.set(id, { loading: true });
  cx.spawn(async (cx) => {
    anchors.set(id, await anchorFor(id).then((a) => ({ a }), (e) => ({ error: String(e?.message ?? e) })));
    cx.notify();
  });
}

// The commented lines (startLine to line) or the `context` lines ending at it, from the end of the hunk,
// numbered on the comment's side (shifted to today's numbers unless outdated). [{ kind, text, no }]
export function anchorLines(a, side = "RIGHT", context = 6) {
  const lines = [];
  let oldNo = 0;
  let newNo = 0;
  for (const l of (a?.diffHunk ?? "").split("\n")) {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    if (!l || l.startsWith("\\")) continue;
    const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
    lines.push({ kind, text: l.slice(1), oldNo: kind === "add" ? null : oldNo++, newNo: kind === "del" ? null : newNo++ });
  }
  const num = (l) => (side === "LEFT" ? l.oldNo : l.newNo);
  const shift = !a?.outdated && a?.line != null && a?.originalLine != null ? a.line - a.originalLine : 0;
  const start = a?.originalStartLine != null ? lines.findIndex((l) => num(l) === a.originalStartLine) : -1;
  return lines.slice(start >= 0 ? start : Math.max(0, lines.length - context))
    .map((l) => ({ kind: l.kind, text: l.text, no: num(l) == null ? null : num(l) + shift }));
}

// "path:12" or "path:10–12" today, "path was line 12" when outdated.
export function anchorLabel(a, path) {
  const [from, to] = a?.outdated || a?.line == null ? [a?.originalStartLine, a?.originalLine] : [a.startLine, a.line];
  const at = from != null && from !== to ? `${from}–${to}` : `${to ?? "?"}`;
  return a?.outdated || a?.line == null ? `${a?.path ?? path} was line ${at}` : `${a?.path ?? path}:${at}`;
}

// The code a card's thread is anchored to, colored like the diff views; it loads when it first lays out.
function anchorView(t, s, i, first, prefix) {
  const got = anchors.get(first.id);
  const frame = (...els) => v_flex().id(`${prefix}-code-${first.id}`).w_full().min_w(0).rounded(rad(s, 6)).border(1).border_color(t.border)
    .bg(t.background).overflow_hidden().children(els);
  if (!got || got.loading) {
    return frame(div().px(8).py(5).text_size(11).text_color(t.dim).loop("opacity", { from: 0.35, to: 1, period: 900 }).child(label(s, "Loading code…")))
      .on_size_change((_size, cx) => loadAnchor(first.id, cx));
  }
  if (got.error) return frame(div().px(8).py(5).whitespace_normal().text_size(11).text_color(t.dim).child(`Couldn't load the code: ${got.error}`));
  const lines = anchorLines(got.a, i.side);
  if (!lines.length) return null;
  const path = got.a.path ?? i.path;
  const lang = langFor(path);
  const colors = paletteFor(t.background);
  const mono = settings().font_family ?? "Menlo";
  const code = (text) => !lang || !text ? div().child(text || " ")
    : h_flex().children(tokens(text, lang).map((tok) => div().text_color(tok.kind ? colors[tok.kind] : t.foreground).child(tok.text)));
  const row = (l) => {
    const mark = { add: t.ansi2, del: t.ansi1 }[l.kind];
    return h_flex().min_w_full().flex_none().items_start().line_height("18px").whitespace_nowrap()
      .when(Boolean(mark), (el) => el.bg(l.kind === "add" ? `${t.ansi2}12` : `${t.ansi1}16`))
      .child(div().w(3).flex_none().self_stretch().when(Boolean(mark), (el) => el.bg(mark)))
      .child(div().w(38).flex_none().pr(6).text_right().text_color(t.dim).opacity(0.8).child(l.no == null ? "" : String(l.no)))
      .child(div().w(14).flex_none().text_color(mark ?? t.dim).child({ add: "+", del: "−" }[l.kind] ?? " "))
      .child(div().flex_none().pr(12).text_color(t.foreground).child(code(l.text)));
  };
  return frame(
    h_flex().px(8).py(3).gap(7).items_center().min_w(0).border_b(1).border_color(t.border).bg(t.surface)
      .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(11).text_color(t.muted).child(anchorLabel(got.a, i.path)))
      .when(Boolean(got.a.outdated), (el) => el.child(chip(t, s, label(s, "Outdated"), t.dim))),
    h_flex().id(`${prefix}-codex-${first.id}`).w_full().min_w(0).py(2).overflow_x_scrollbar()
      .child(v_flex().flex_none().min_w_full().font_family(mono).text_size(12).children(lines.map(row))));
}

// One comment for an agent: the PR, who said it, the line and its code when it's inline (hunk: GitHub's
// diff hunk, used when the parsed diff doesn't have the line), the comment, and your note.
export function commentMessage(url, files, c, note, hunk) {
  const said = `${c.author} ${c.path ? "commented" : `wrote ${c.where ?? "a comment"}`}:\n> ${c.body.trim().slice(0, 4000).replace(/\n/g, "\n> ")}`;
  const text = [said, note && `My note: ${note}`].filter(Boolean).join("\n\n");
  if (!c.path) return `On ${url}, ${text}`;
  const at = { path: c.path, side: c.side ?? "RIGHT", line: c.line ?? c.originalLine ?? "?" };
  const known = snippet(files?.find((f) => f.name === c.path), at.side, at.line) != null;
  const code = !known && hunk ? `\`\`\`diff\n${hunk.split("\n").slice(-8).join("\n")}\n\`\`\`\n` : "";
  return agentMessage(url, files, [{ ...at, body: `${code}${text}` }]);
}

// Jira tickets and other GitHub PRs open in the previews, as the chat does; other links (and this PR's) in the browser.
export function openLink(url, cx, current) {
  const ticket = /atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(url);
  if (ticket) return openOverlay({ mod: "jira-preview", props: { key: ticket[1] }, kind: "dialog", width: 820, height: 0.9 });
  const pr = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  const base = pr && `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}`;
  if (pr && base !== current) return openOverlay({ mod: "pr-preview", props: { url: base, key: `${pr[2]}#${pr[3]}` }, kind: "dialog", width: 0.85, height: 0.9 });
  cx.open_url(url);
}

// toReview: into your pending review, else posted now.
export async function replyTo(data, threadId, body, toReview) {
  const review = toReview ? await pendingReview(data) : null;
  await mutate(REPLY, { thread: threadId, body, review });
}

// A new line comment into your pending review (started when there's none).
export async function addThread(data, c) {
  const review = await pendingReview(data);
  await mutate(ADD_THREAD, { review, path: c.path, line: c.line, side: c.side ?? "RIGHT", body: c.body });
}

// Adds line comments to your pending review, then submits it. added(c) runs as each one lands.
export async function submitPending(reviewId, comments, event, body, added) {
  for (const c of comments) {
    await mutate(ADD_THREAD, { review: reviewId, path: c.path, line: c.line, side: c.side ?? "RIGHT", body: c.body });
    added(c);
  }
  await mutate(SUBMIT, { review: reviewId, event, body: body || null });
}

// Reply boxes on thread cards, per thread id, and per-comment state (the selected comment, edit and
// Send to agent boxes, a delete waiting on its second click), kept while the view lives. data() is the
// PR's threads, reload(cx) fetches them again, agent() the PR's agent session (or null), files() the
// parsed diff, quote(c, cx) (optional) replies to a comment outside a thread, drafts (optional) the
// agent-written replies (lib/drafts.js) cards draw under their thread.
export class Replies {
  constructor({ data, reload, agent, files, quote, drafts }) {
    this.drafts = drafts ?? null;
    this.boxes = new Map();
    this.edits = new Map();
    this.notes = new Map();
    this.selected = null;
    this.confirm = null;
    this.busy = null;
    this.data = data;
    this.reload = reload;
    this.agent = agent;
    this.files = files;
    this.quote = quote ?? null;
  }

  select(c, cx) {
    this.selected = this.selected === c.id ? null : c.id;
    cx.notify();
  }

  // Runs one GitHub write for id (a comment's or thread's), then reloads; a dry run only says it logged.
  write(id, what, go, cx) {
    if (this.busy) return;
    this.busy = { id, what };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await go();
        if (shared(DRY_RUN)) notify({ title: `Dry run: ${what} logged`, body: "inspect/gh-dry-run.log", level: "info", timeout: 3000 });
        else this.reload(cx);
      } catch (e) {
        notify({ title: `Couldn't ${what}`, body: String(e?.message ?? e), level: "error", timeout: 5000 });
      }
      this.busy = null;
      cx.notify();
    });
  }

  resolve(i, cx) {
    this.write(i.id, i.resolved ? "unresolve" : "resolve", () => setResolved(i.id, !i.resolved), cx);
  }

  startEdit(c, cx) {
    this.edits.set(c.id, { input: TextareaState.new({ value: c.body, rows: 4 }), error: null });
    cx.notify();
  }

  saveEdit(c, cx) {
    const box = this.edits.get(c.id);
    const body = box?.input.value().trim();
    if (!box || this.busy) return;
    if (!body) {
      box.error = "A comment can't be empty; delete it instead.";
      return cx.notify();
    }
    this.write(c.id, "edit", async () => { await editComment(c, body); this.edits.delete(c.id); }, cx);
  }

  // The first click asks; a second within 4s deletes.
  del(c, cx) {
    if (this.confirm !== c.id) {
      this.confirm = c.id;
      cx.notify();
      cx.timer.after(4000, (cx) => { if (this.confirm === c.id) this.confirm = null; cx.notify(); });
      return;
    }
    this.confirm = null;
    this.write(c.id, "delete", async () => { await deleteComment(c); if (this.selected === c.id) this.selected = null; }, cx);
  }

  openNote(c, cx) {
    this.notes.set(c.id, { input: TextareaState.new({ placeholder: "Optional note for the agent", rows: 2 }), busy: false, error: null });
    cx.notify();
  }

  // c, with the note, to the agent as one message.
  noteToAgent(c, cx) {
    const box = this.notes.get(c.id);
    const address = this.agent();
    if (!box || box.busy || !address) return;
    box.busy = true;
    box.error = null;
    cx.notify();
    const note = box.input.value().trim();
    cx.spawn(async (cx) => {
      const files = this.files();
      const known = c.path && snippet(files?.find((f) => f.name === c.path), c.side ?? "RIGHT", c.line ?? c.originalLine) != null;
      const hunk = c.path && !known && c.kind === "review-comment" ? await hunkFor(c.id).catch(() => null) : null;
      box.error = await sendToAgent(address, commentMessage(this.data()?.url, files, c, note, hunk));
      box.busy = false;
      if (!box.error) {
        this.notes.delete(c.id);
        notify({ title: `Sent to ${agentName(address)}`, level: "info", timeout: 3000 });
      }
      cx.notify();
    });
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

  // resolve: post now, then resolve the thread (GitHub's "Resolve with comment").
  send(id, toReview, cx, resolve = false) {
    const box = this.boxes.get(id);
    const body = box?.input.value().trim();
    const data = this.data();
    if (!box || box.busy || !data) return;
    if (!body) {
      box.error = "Write a reply first.";
      return cx.notify();
    }
    box.busy = toReview ? "review" : resolve ? "resolve" : "now";
    box.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await replyTo(data, id, body, toReview);
        if (resolve) await setResolved(id, true);
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

// A markdown body that collapses to a few lines when long. Links open as the chat opens them.
function body(t, s, c, open, prefix, current) {
  const long = c.body.length > 480 || c.body.split("\n").length > 7;
  const key = `b:${c.id}`;
  const shown = !long || open.has(key);
  return v_flex().gap(3)
    .child(div().whitespace_normal().text_size(12).when(!shown, (el) => el.max_h(118).overflow_hidden())
      .child(TextView.markdown(`${prefix}-${c.id}`, c.body || "_(empty)_").on_link_click((url, cx) => openLink(url, cx, current))))
    .when(long, (el) => el.child(div().id(`${prefix}-more-${c.id}`).text_size(11).text_color(t.accent).cursor_pointer()
      .on_click(flip(open, key)).child(label(s, shown ? "Show less" : "Show more"))));
}

const link = (t, s, id, text, go, color) => div().id(id).flex_none().text_size(11).text_color(color ?? t.accent).cursor_pointer()
  .hover((el) => el.opacity(0.75)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((e, cx) => { cx.stop_propagation(); go(e, cx); }).child(label(s, text));

const button = (t, s, id, text, primary, go) => div().id(id).px(10).py(4).rounded(rad(s, 6)).text_size(11.5)
  .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((el) => el.opacity(0.85)))
  .when(!primary, (el) => el.border(1).border_color(t.border).text_color(t.foreground).hover((el) => el.bg(t.hover)))
  .on_click(go).child(label(s, text));

const resolvable = (th) => th?.kind === "thread" && (th.resolved ? th.canUnresolve !== false : th.canResolve !== false);

// A selected comment's actions: Reply · Send to agent · Resolve · Edit · Delete · Copy link · Open on GitHub.
export function actionBar(t, s, c, rep, prefix) {
  const th = c.thread;
  const busy = rep.busy && (rep.busy.id === c.id || rep.busy.id === th?.id) ? rep.busy.what : null;
  const id = (k) => `${prefix}-a${k}-${c.id}`;
  const items = [
    th ? link(t, s, id("r"), "Reply", (_e, cx) => rep.open(th.id, cx)) : rep.quote && link(t, s, id("r"), "Reply", (_e, cx) => rep.quote(c, cx)),
    rep.agent?.() && link(t, s, id("g"), "Send to agent", (_e, cx) => rep.openNote(c, cx)),
    resolvable(th) && link(t, s, id("v"), th.resolved ? "Unresolve" : "Resolve", (_e, cx) => rep.resolve(th, cx)),
    canEdit(c) && link(t, s, id("e"), "Edit", (_e, cx) => rep.startEdit(c, cx)),
    canDelete(c) && link(t, s, id("d"), rep.confirm === c.id ? "Click again to delete" : "Delete", (_e, cx) => rep.del(c, cx), t.blocked),
    c.url && link(t, s, id("c"), "Copy link", (_e, cx) => { cx.write_to_clipboard(c.url); notify({ title: "Link copied", level: "info", timeout: 1500 }); }, t.muted),
    c.url && link(t, s, id("o"), "Open on GitHub", (_e, cx) => cx.open_url(c.url), t.muted),
  ].filter(Boolean);
  return h_flex().gap(12).flex_wrap().items_center().pl(2)
    .children(items)
    .when(Boolean(busy), (el) => el.child(div().text_size(11).text_color(t.working).child(label(s, `${busy}…`))));
}

// A comment: clicking it selects it and shows its actions; Edit swaps in a box; Send to agent opens a
// note box. c carries its place (path, side, line, thread) when it's inline.
export function commentBody(t, s, c, open, prefix, rep) {
  const current = rep?.data()?.url;
  if (!rep) return body(t, s, c, open, prefix, current);
  const edit = rep.edits.get(c.id);
  const note = rep.notes.get(c.id);
  const sel = rep.selected === c.id;
  if (edit) {
    return v_flex().gap(6)
      .child(div().id(`${prefix}-ebox-${c.id}`).rounded(rad(s, 6)).border(1).border_color(t.accent).bg(t.background).p(6)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(edit.input).h(84).text_size(12.5).text_color(t.foreground)))
      .when(Boolean(edit.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(edit.error ?? "")))
      .child(h_flex().gap(8).justify_end()
        .child(button(t, s, `${prefix}-ecancel-${c.id}`, "Cancel", false, (_e, cx) => { rep.edits.delete(c.id); cx.notify(); }))
        .child(button(t, s, `${prefix}-esave-${c.id}`, rep.busy?.id === c.id ? "Saving…" : "Save", true, (_e, cx) => rep.saveEdit(c, cx))));
  }
  return v_flex().gap(5)
    .child(div().id(`${prefix}-sel-${c.id}`).px(4).py(2).rounded(rad(s, 6)).cursor_pointer()
      .when(sel, (el) => el.bg(t.hover)).hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => rep.select(c, cx))
      .child(body(t, s, c, open, prefix, current)))
    .when(sel, (el) => el.child(actionBar(t, s, c, rep, prefix)))
    .when(Boolean(note), (el) => el.child(v_flex().gap(6)
      .child(div().text_size(11).text_color(t.dim).child(`To ${agentName(rep.agent?.() ?? "")}: this comment${c.path ? " with its code" : ""}, plus your note`))
      .child(div().id(`${prefix}-nbox-${c.id}`).rounded(rad(s, 6)).border(1).border_color(t.accent).bg(t.background).p(6)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(note.input).h(44).text_size(12.5).text_color(t.foreground)))
      .when(Boolean(note?.error), (el) => el.child(div().whitespace_normal().text_size(11.5).text_color(t.blocked).child(note?.error ?? "")))
      .child(h_flex().gap(8).justify_end()
        .child(button(t, s, `${prefix}-ncancel-${c.id}`, "Cancel", false, (_e, cx) => { rep.notes.delete(c.id); cx.notify(); }))
        .child(button(t, s, `${prefix}-nsend-${c.id}`, note?.busy ? "Sending…" : "Send to agent", true, (_e, cx) => rep.noteToAgent(c, cx))))));
}

export function chip(t, s, text, color) {
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
      .when(Boolean(i.canResolve && !i.resolved), (el) => el.child(act("rres", box.busy === "resolve" ? "Posting…" : "Reply & resolve", false, (_e, cx) => rep.send(i.id, false, cx, true))))
      .child(act("rnow", box.busy === "now" ? "Posting…" : "Reply now", true, (_e, cx) => rep.send(i.id, false, cx))));
}

// One thread or pending-on-GitHub card. open: a Set of toggled keys the mod keeps; w: its width; rep: the
// view's Replies, for a Reply box, Resolve and each comment's actions. i.flat: it sits under a row that
// already expanded it, so no header of its own: the code, every comment with its author, one action row.
export function card(t, s, i, open, w, prefix, rep) {
  const ghPending = i.kind === "github-pending";
  const dim = i.resolved || i.outdated;
  const flat = Boolean(i.flat);
  // A thread with an agent's draft starts open, so the comment shows beside the reply to it.
  const drafted = Boolean(rep?.drafts && !i.noDrafts && rep.drafts.placed().some((p) => p.kind === "thread" && p.thread.id === i.id));
  const expanded = flat || isOpen(open, i.id, dim && !drafted);
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
  // Shown by default when one is pending, so a reply you just added is in view; flat, also when there are few.
  const fold = !flat || replies.length > 3;
  const showReplies = open.has(repliesKey) !== (!fold || replies.some((c) => c.pending));
  const placed = (c) => ({ ...c, path: i.path, side: i.side, line: i.line, originalLine: i.originalLine, thread: i });
  const reply = (c, top) => v_flex().gap(4).when(!top, (el) => el.pl(10).border_l(2).border_color(c.pending ? t.ansi5 : t.border))
    .child(h_flex().gap(7).items_center()
      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(c.author))
      .child(div().text_size(10.5).text_color(t.dim).child(ago(c.createdAt)))
      .when(c.pending, (el) => el.child(chip(t, s, label(s, "Pending on GitHub"), t.ansi5))))
    .child(commentBody(t, s, placed(c), open, prefix, rep));
  const resolving = rep?.busy?.id === i.id;
  // A shown, selected comment's action bar carries the thread's actions, so the footer steps aside.
  const sel = rep && !rep.edits.has(rep.selected) && (first?.id === rep.selected || (showReplies && replies.some((c) => c.id === rep.selected)));
  return v_flex().id(`${prefix}-${i.id}`).when(w == null, (el) => el.mx(0)).when(w != null, (el) => el.w(w).mx(10)).my(5).p(9).gap(7).rounded(rad(s, 8)).border(1).border_l(3)
    .border_color(ghPending ? t.ansi5 : dim && !drafted ? t.border : color).bg(t.popover)
    .when(dim && !flat && !drafted, (el) => el.opacity(0.62))
    .when(!flat, (el) => el.child(head))
    .when(expanded && Boolean(first), (el) => el
      .when(!i.anchored && !i.file, (el) => el.children([anchorView(t, s, i, first, prefix)].filter(Boolean)))
      .child(flat ? reply(first, true) : commentBody(t, s, placed(first), open, prefix, rep))
      .when(replies.length > 0, (el) => el
        .when(fold, (el) => el.child(div().id(`${prefix}-rt-${i.id}`).text_size(11).text_color(t.accent).cursor_pointer().on_click(flip(open, repliesKey))
          .child(label(s, showReplies ? "Hide replies" : `${replies.length} repl${replies.length === 1 ? "y" : "ies"}`))))
        .when(showReplies, (el) => el.children(replies.map((c) => reply(c)))))
      .when(!sel, (el) => el.child(h_flex().gap(14).items_center()
        .when(Boolean(rep) && !rep?.boxes.has(i.id), (el) => el.child(replyBox(t, s, i, rep, prefix)))
        .when(Boolean(rep) && resolvable(i), (el) => el.child(link(t, s, `${prefix}-res-${i.id}`, resolving ? `${rep.busy.what}…` : i.resolved ? "Unresolve" : "Resolve",
          (_e, cx) => rep.resolve(i, cx), i.resolved ? t.muted : t.done)))
        .when(Boolean(first?.url), (el) => el.child(div().id(`${prefix}-gh-${i.id}`).text_size(10.5).text_color(t.dim).cursor_pointer()
          .hover((el) => el.text_color(t.accent)).on_click(() => exec("open", [first.url])).child(label(s, "Open on GitHub")))))))
    .when(Boolean(rep?.boxes.has(i.id)), (el) => el.child(replyBox(t, s, i, rep, prefix)))
    .children(rep?.drafts && !i.noDrafts ? rep.drafts.forThread(t, s, i, prefix) : []);
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
