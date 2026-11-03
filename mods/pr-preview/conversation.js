// The PR's Conversation tab, as GitHub draws it: the description, comments, reviews with their inline
// comments (each opens to its thread), commits, force-pushes, labels and state changes, then CI.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { exec, home } from "herdr";
import { label, rad } from "./style.js";
import { ago, comment, card, commentBody, chip } from "./threads.js";

const ICONS = "mods/workspace-chrome";
// The newest PAGES × PAGE items; older ones stay on GitHub.
const PAGE = 50;
const PAGES = 5;
const TYPES = "ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT, " +
  "CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, REVIEW_REQUESTED_EVENT, " +
  "REVIEW_DISMISSED_EVENT, RENAMED_TITLE_EVENT, BASE_REF_CHANGED_EVENT, HEAD_REF_DELETED_EVENT";
const ACTOR = "actor { login } createdAt";
const QUERY = `query($owner: String!, $repo: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    id author { login } createdAt body url viewerDidAuthor
    timelineItems(last: ${PAGE}, before: $before, itemTypes: [${TYPES}]) { totalCount pageInfo { hasPreviousPage startCursor } nodes {
      __typename
      ... on IssueComment { id author { login } body createdAt url viewerDidAuthor }
      ... on PullRequestReview { id author { login } body state createdAt submittedAt url viewerDidAuthor
        comments(first: 30) { totalCount nodes { id path line originalLine body createdAt url viewerDidAuthor replyTo { id } author { login } } } }
      ... on PullRequestCommit { commit { abbreviatedOid messageHeadline committedDate url author { name user { login } } } }
      ... on HeadRefForcePushedEvent { ${ACTOR} beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
      ... on LabeledEvent { ${ACTOR} label { name color } }
      ... on UnlabeledEvent { ${ACTOR} label { name color } }
      ... on ClosedEvent { ${ACTOR} }
      ... on ReopenedEvent { ${ACTOR} }
      ... on ReadyForReviewEvent { ${ACTOR} }
      ... on ConvertToDraftEvent { ${ACTOR} }
      ... on MergedEvent { ${ACTOR} commit { abbreviatedOid } mergeRefName }
      ... on ReviewRequestedEvent { ${ACTOR} requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } }
      ... on ReviewDismissedEvent { ${ACTOR} review { author { login } } }
      ... on RenamedTitleEvent { ${ACTOR} previousTitle currentTitle }
      ... on BaseRefChangedEvent { ${ACTOR} previousRefName currentRefName }
      ... on HeadRefDeletedEvent { ${ACTOR} }
    } }
  } }
}`;

const REVIEWED = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "reviewed (dismissed)", PENDING: "has a pending review" };

// One line for an event, or null for a type we don't show.
export function event(n) {
  const who = n.actor?.login ?? "someone";
  switch (n.__typename) {
    case "LabeledEvent": return { icon: "layers", text: `${who} added the ${n.label?.name} label`, color: `#${n.label?.color}` };
    case "UnlabeledEvent": return { icon: "layers", text: `${who} removed the ${n.label?.name} label`, color: `#${n.label?.color}` };
    case "HeadRefForcePushedEvent": return { icon: "git-branch", text: `${who} force-pushed ${n.beforeCommit?.abbreviatedOid ?? "?"} → ${n.afterCommit?.abbreviatedOid ?? "?"}`, tone: "working" };
    case "ClosedEvent": return { icon: "x", text: `${who} closed this`, tone: "blocked" };
    case "ReopenedEvent": return { icon: "git-branch", text: `${who} reopened this`, tone: "done" };
    case "ReadyForReviewEvent": return { icon: "circle-check", text: `${who} marked this ready for review`, tone: "done" };
    case "ConvertToDraftEvent": return { icon: "square-pen", text: `${who} converted this to a draft`, tone: "working" };
    case "MergedEvent": return { icon: "git-branch", text: `${who} merged ${n.commit?.abbreviatedOid ?? ""} into ${n.mergeRefName}`, tone: "ansi5" };
    case "ReviewRequestedEvent": return { icon: "clock", text: `${who} requested a review from ${n.requestedReviewer?.login ?? n.requestedReviewer?.name ?? "someone"}` };
    case "ReviewDismissedEvent": return { icon: "x", text: `${who} dismissed ${n.review?.author?.login ?? "someone"}'s review` };
    case "RenamedTitleEvent": return { icon: "square-pen", text: `${who} renamed this from “${n.previousTitle}”` };
    case "BaseRefChangedEvent": return { icon: "git-branch", text: `${who} changed the base from ${n.previousRefName} to ${n.currentRefName}` };
    case "HeadRefDeletedEvent": return { icon: "x", text: `${who} deleted the branch` };
    default: return null;
  }
}

// One page's nodes as items, oldest first. Runs of commits fold into one item.
export function parseNodes(nodes) {
  const items = [];
  for (const n of nodes) {
    const at = n.createdAt ?? n.commit?.committedDate;
    if (n.__typename === "IssueComment") items.push({ type: "comment", at, c: { ...comment(n, "issue-comment"), where: "a PR comment" } });
    else if (n.__typename === "PullRequestReview") {
      const when = n.submittedAt ?? at;
      items.push({ type: "review", at: when, state: n.state, more: n.comments.totalCount - n.comments.nodes.length,
        c: { ...comment(n, "review"), createdAt: when, where: `a review (${REVIEWED[n.state] ?? n.state.toLowerCase()})` },
        comments: n.comments.nodes.map((x) => ({ ...comment(x), path: x.path, line: x.line, originalLine: x.originalLine, side: "RIGHT", reply: Boolean(x.replyTo) })) });
    } else if (n.__typename === "PullRequestCommit") {
      const c = n.commit;
      const commit = { oid: c.abbreviatedOid, headline: c.messageHeadline, url: c.url, author: c.author?.user?.login ?? c.author?.name ?? "" };
      const last = items[items.length - 1];
      if (last?.type === "commits") last.list.push(commit);
      else items.push({ type: "commits", at, list: [commit] });
    } else {
      const e = event(n);
      if (e) items.push({ type: "event", at, ...e });
    }
  }
  return items;
}

// { description, items, older (items left on GitHub), error }. Read-only; the newest PAGES pages.
export async function loadTimeline(url, run = (args) => exec("gh", args, { cwd: home() })) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return { items: [], error: "Not a PR url" };
  const pages = [];
  let description = null;
  let before = null;
  let older = 0;
  for (let p = 0; p < PAGES; p++) {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${m[1]}`, "-F", `repo=${m[2]}`, "-F", `number=${m[3]}`];
    if (before) args.push("-f", `before=${before}`);
    const r = await run(args);
    if (r.code !== 0) return { description, items: pages.reverse().flat(), older, error: r.stderr.trim() || "gh api graphql failed" };
    const pr = JSON.parse(r.stdout).data?.repository?.pullRequest;
    if (!pr) return { description, items: [], older, error: "PR not found" };
    description ??= { ...comment(pr, "description"), id: `desc-${pr.id}`, where: "the PR description",
      body: (pr.body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trim() };
    pages.push(pr.timelineItems.nodes);
    const info = pr.timelineItems.pageInfo;
    older = info.hasPreviousPage ? pr.timelineItems.totalCount - pages.reduce((n, x) => n + x.length, 0) : 0;
    if (!info.hasPreviousPage) break;
    before = info.startCursor;
  }
  return { description, items: parseNodes(pages.reverse().flat()), older, error: null };
}

const avatar = (t, who) => div().size(22).flex_none().rounded(11).bg(t.raised).flex().items_center().justify_center()
  .text_size(11).font_bold().text_color(t.muted).child((who || "?").slice(0, 1).toUpperCase());

const head = (t, who, verb, at) => h_flex().gap(7).items_center().min_w(0).flex_wrap()
  .child(avatar(t, who))
  .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child(who))
  .when(Boolean(verb), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child(verb)))
  .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(at)));

const box = (t, s, id, color) => v_flex().id(id).p(10).gap(7).rounded(rad(s, 8)).border(1).border_color(t.border)
  .when(Boolean(color), (el) => el.border_l(3).border_color(color)).bg(t.background);

// The index of the item whose comment url (or one of a review's inline ones) match(url) picks, or -1.
export function findItem(data, match) {
  if (!data || !match) return -1;
  return data.items.findIndex((it) => match(it.c?.url) || (it.comments ?? []).some((c) => match(c.url)));
}

// The tab. ctx: { data (loadTimeline), threads, open, rep, checks, reply (the comment box's state, or null
// while the review composer has it), submit(cx), submitting, error, url, focus: { index, match } (a link's
// target: shown first and outlined), unfocus(cx) }.
export function conversation(t, s, ctx) {
  const { data, open, rep } = ctx;
  if (!data) return div().p(20).text_size(12.5).text_color(t.muted)
    .child(div().loop("opacity", { from: 0.35, to: 1, period: 900 }).child("Loading conversation…"));
  if (data.error && !data.items.length && !data.description) return div().p(20).text_size(12.5).text_color(t.blocked).child(data.error);
  // Each inline comment's thread, so a review's comments open to it.
  const threadOf = new Map();
  for (const i of ctx.threads?.items ?? []) for (const c of i.comments) threadOf.set(c.id, i);
  const rows = [];
  const from = Math.max(0, ctx.focus?.index ?? 0);
  const hit = (c) => Boolean(ctx.focus?.match?.(c?.url));
  const d = data.description;
  if (from > 0) rows.push(div().id("cv-earlier").px(4).text_size(11.5).text_color(t.accent).cursor_pointer().hover((el) => el.opacity(0.75))
    .on_click((_e, cx) => ctx.unfocus(cx)).child(label(s, `Show the description and ${from} earlier item${from === 1 ? "" : "s"}`)));
  else if (d) rows.push(box(t, s, "cv-desc", t.accent)
    .child(head(t, d.author, "opened this", d.createdAt))
    .child(d.body ? commentBody(t, s, d, open, "cvd", rep) : div().text_size(12).text_color(t.muted).child(label(s, "No description."))));
  if (data.older > 0 && from === 0) rows.push(div().id("cv-older").px(4).text_size(11.5).text_color(t.accent).cursor_pointer().hover((el) => el.opacity(0.75))
    .on_click((_e, cx) => cx.open_url(ctx.url)).child(label(s, `${data.older} earlier items on GitHub`)));
  data.items.forEach((it, k) => {
    if (k < from) return;
    if (it.type === "comment") {
      rows.push(box(t, s, `cv-${k}`, hit(it.c) && t.accent).child(head(t, it.c.author, "commented", it.c.createdAt)).child(commentBody(t, s, it.c, open, "cvc", rep)));
    } else if (it.type === "review") {
      const color = { APPROVED: t.done, CHANGES_REQUESTED: t.blocked, PENDING: t.ansi5 }[it.state] ?? t.muted;
      const verb = REVIEWED[it.state] ?? it.state.toLowerCase();
      if (!it.c.body && !it.comments.length) {
        rows.push(h_flex().px(4).gap(8).items_center()
          .child(div().size(8).flex_none().rounded(4).bg(color))
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(it.c.author))
          .child(div().text_size(12).text_color(color).child(verb))
          .child(div().text_size(11).text_color(t.dim).child(ago(it.at))));
        return;
      }
      const inline = it.comments.map((c) => {
        const th = threadOf.get(c.id);
        const key = `cvr:${c.id}`;
        const shown = open.has(key) !== hit(c);
        return v_flex().gap(4)
          .child(h_flex().id(`cvi-${c.id}`).h(24).px(6).gap(8).items_center().rounded(rad(s, 6)).cursor_pointer().hover((el) => el.bg(t.hover))
            .when(hit(c), (el) => el.bg(`${t.accent}22`))
            .on_click((_e, cx) => { open.has(key) ? open.delete(key) : open.add(key); cx.notify(); })
            .child(svg(`${ICONS}/chevron-${shown ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.muted))
            .child(div().flex_none().max_w(300).truncate().text_size(11).text_color(t.accent).child(`${c.path}:${c.line ?? c.originalLine ?? "?"}`))
            .when(c.reply, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(label(s, "reply"))))
            .when(Boolean(th?.resolved), (el) => el.child(chip(t, s, label(s, "Resolved"), t.done)))
            .when(Boolean(th?.outdated), (el) => el.child(chip(t, s, label(s, "Outdated"), t.dim)))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(c.body.split("\n")[0])))
          // Its thread when we have it (Resolve, Reply, every comment), else the comment alone.
          .when(shown, (el) => el.child(th
            ? card(t, s, { ...th, anchored: false, flat: true }, open, null, "cvt", rep)
            : v_flex().ml(20).child(commentBody(t, s, c, open, "cvx", rep))));
      });
      rows.push(box(t, s, `cv-${k}`, color).when(hit(it.c), (el) => el.border(2).border_color(t.accent))
        .child(head(t, it.c.author, verb, it.at))
        .when(Boolean(it.c.body), (el) => el.child(commentBody(t, s, it.c, open, "cvb", rep)))
        .when(inline.length > 0, (el) => el
          .child(div().text_size(10.5).text_color(t.dim).child(label(s, `${inline.length + it.more} inline comment${inline.length + it.more === 1 ? "" : "s"}${it.more ? ` (${it.more} more on GitHub)` : ""}`)))
          .children(inline)));
    } else if (it.type === "commits") {
      rows.push(v_flex().px(4).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(svg(`${ICONS}/git-branch.svg`).size(13).flex_none().text_color(t.muted))
          .child(div().text_size(11.5).text_color(t.muted).child(`${it.list.length} commit${it.list.length === 1 ? "" : "s"} pushed`))
          .child(div().text_size(11).text_color(t.dim).child(ago(it.at))))
        .children(it.list.map((c, j) => h_flex().id(`cvm-${k}-${j}`).pl(21).h(20).gap(8).items_center().cursor_pointer()
          .hover((el) => el.opacity(0.75)).on_click((_e, cx) => cx.open_url(c.url))
          .child(div().flex_none().font_family("JetBrains Mono").text_size(11).text_color(t.accent).child(c.oid))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(c.headline))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.author)))));
    } else {
      rows.push(h_flex().px(4).gap(8).items_center().min_w(0)
        .child(svg(`${ICONS}/${it.icon}.svg`).size(13).flex_none().text_color(it.color ?? (it.tone ? t[it.tone] : t.muted)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(it.text))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(it.at))));
    }
  });
  const c = ctx.checks;
  if (c && c.passed + c.failing.length + c.pending > 0) {
    const tone = c.failing.length ? t.blocked : c.pending ? t.working : t.done;
    rows.push(box(t, s, "cv-ci", tone)
      .child(h_flex().gap(8).items_center()
        .child(svg(`${ICONS}/${c.failing.length ? "x" : "circle-check"}.svg`).size(14).flex_none().text_color(tone))
        .child(div().text_size(12).font_semibold().text_color(t.foreground)
          .child(c.failing.length ? "Some checks failed" : c.pending ? "Checks running" : "All checks passed")))
      .child(h_flex().gap(10).flex_wrap().text_size(11.5)
        .child(div().text_color(t.done).child(`${c.passed} passed`))
        .when(c.failing.length > 0, (el) => el.child(div().whitespace_normal().text_color(t.blocked).child(`${c.failing.length} failing: ${c.failing.join(", ")}`)))
        .when(c.pending > 0, (el) => el.child(div().text_color(t.working).child(`${c.pending} pending`)))));
  }
  // The comment box: posts to the conversation as you.
  const composer = ctx.reply && v_flex().gap(8)
    .child(div().id("cv-reply").rounded(rad(s, 8)).border(1).border_color(t.border).bg(t.background).p(8)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Textarea.new(ctx.reply).h(72).text_size(12.5).text_color(t.foreground)))
    .when(Boolean(ctx.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(ctx.error ?? "")))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child("Click a comment for its actions · posts as you"))
      .child(div().id("cv-post").flex_none().px(12).py(5).rounded(rad(s, 7)).bg(t.solid).text_size(12).text_color(t.solid_foreground)
        .hover((el) => el.opacity(0.85)).on_click((_e, cx) => ctx.submit(cx))
        .child(label(s, ctx.submitting === "comment" ? "Posting…" : "Comment"))));
  return v_flex().id("conversation").flex_1().min_h(0).px(16).py(14).gap(12).overflow_y_scrollbar()
    .when(Boolean(data.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(data.error ?? "")))
    .children(rows)
    .when(Boolean(composer), (el) => el.child(composer));
}
