// The inbox: agents that need you, then your open PRs, PRs to review and Jira issues in one list.
// Click a row to preview it. Tabs, queries and start actions (a review, a ticket workflow) come from
// setup.json; an item with a running session (or a PR whose branch names a ticket's session) links back to it.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, openOverlay, agents, terminals, window as appWindow } from "herdr";
import { sessionFor, sessionIn, statusOf, openSession, startSession } from "./session.js";
import { setup, fill } from "./setup.js";
import { style, label, rad, badge, heading, brackets, LETTER } from "./style.js";

const REFRESH_MS = 120000;

const ago = (iso) => {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

const CI = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "needs review" };
// What a blocked agent reported it's waiting on (OSC 7501 kind).
const WAITING = { permission: "Needs permission", question: "Has a question" };

// GitHub search strings come from setup.json, as typed in the PR search box (advanced search: OR and parentheses work).
const PR_FIELDS = `number title url isDraft updatedAt state baseRefName headRefName author { login }
  repository { name nameWithOwner defaultBranchRef { name } }`;
const SEARCH = `query($q: String!) {
  search(query: $q, type: ISSUE_ADVANCED, first: 30) {
    nodes { ... on PullRequest { ${PR_FIELDS} reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }
  }
}`;
const STACK_DEPTH = 8;

// Where a PR sits in a stack: its repo, the branch it targets and its own branch.
const prBase = (p) => ({
  key: `${p.repository.name}#${p.number}`,
  number: p.number,
  title: p.title,
  url: p.url,
  branch: p.headRefName,
  base: p.baseRefName,
  repo: p.repository.nameWithOwner,
  trunk: p.repository.defaultBranchRef?.name ?? null,
  state: p.state,
  preview: "pr-preview",
});

async function gh(q, action) {
  const r = await exec("gh", ["api", "graphql", "-f", `q=${q}`, "-f", `query=${SEARCH}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "gh failed");
  return JSON.parse(r.stdout).data.search.nodes.filter((p) => p.number).map((p) => ({
    ...prBase(p),
    ci: CI[p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] ?? null,
    review: p.isDraft ? null : p.reviewDecision ?? null,
    meta: [p.isDraft ? "draft" : null, p.author?.login, ago(p.updatedAt)].filter(Boolean).join(" · "),
    action: action ? { label: fill(action.label, { url: p.url }), prompt: fill(action.prompt, { url: p.url }) } : null,
  }));
}

// The PRs whose branch is each { repo, branch }, one query for all: an open one, else the latest merged or closed.
async function prsByBranch(wanted) {
  const args = [];
  const vars = [];
  const parts = wanted.map((w, i) => {
    const [owner, name] = w.repo.split("/");
    args.push(`$o${i}: String!, $n${i}: String!, $b${i}: String!`);
    vars.push("-f", `o${i}=${owner}`, "-f", `n${i}=${name}`, "-f", `b${i}=${w.branch}`);
    return `p${i}: repository(owner: $o${i}, name: $n${i}) { pullRequests(headRefName: $b${i}, states: [OPEN, MERGED, CLOSED], first: 5,
      orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } } }`;
  });
  const r = await exec("gh", ["api", "graphql", "-f", `query=query(${args.join(", ")}) { ${parts.join("\n")} }`, ...vars]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "gh failed");
  const data = JSON.parse(r.stdout).data ?? {};
  return wanted.map((_w, i) => {
    const nodes = data[`p${i}`]?.pullRequests?.nodes ?? [];
    const p = nodes.find((n) => n.state === "OPEN") ?? nodes.find((n) => n.state === "MERGED") ?? nodes[0];
    return p ? { ...prBase(p), outside: true, meta: [p.author?.login, ago(p.updatedAt)].filter(Boolean).join(" · ") } : null;
  });
}

// The PRs a tab's PRs are stacked on that the tab doesn't list (a teammate's, a merged one), walked up to the trunk.
async function stackParents(items) {
  const found = [];
  const known = new Set(items.map((i) => `${i.repo}:${i.branch}`));
  let todo = items;
  for (let depth = 0; depth < STACK_DEPTH && todo.length; depth++) {
    const wanted = [];
    for (const n of todo) {
      const k = `${n.repo}:${n.base}`;
      if (n.base === n.trunk || known.has(k)) continue;
      known.add(k);
      wanted.push({ repo: n.repo, branch: n.base });
    }
    if (!wanted.length) break;
    todo = (await prsByBranch(wanted)).filter(Boolean);
    found.push(...todo);
  }
  return found;
}

// The list in order: a standalone PR as { item }, a stack as { root, target, members } where each member has its
// depth, position ("2/3", "2a/3" beside a sibling), which ancestor columns still continue (rails), and a retarget
// warning when the PR it sits on was merged or closed. A stack takes the place of its first PR in the list.
function stackEntries(items, outside) {
  const all = [...items, ...outside];
  const byBranch = new Map(all.map((n) => [`${n.repo}:${n.branch}`, n]));
  const parentOf = (n) => {
    const p = byBranch.get(`${n.repo}:${n.base}`);
    return p && p !== n ? p : null;
  };
  const kids = new Map();
  for (const n of all) {
    const p = parentOf(n);
    if (p) kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const rootOf = (n) => {
    const seen = new Set([n]);
    for (let p = parentOf(n); p && !seen.has(p); p = parentOf(p)) { seen.add(p); n = p; }
    return n;
  };
  const entries = [];
  const done = new Set();
  for (const item of items) {
    if (done.has(item)) continue;
    const root = rootOf(item);
    if (root === item && !kids.has(item)) { entries.push({ item }); continue; }
    const members = [];
    const walk = (n, depth, rails, last, seen) => {
      members.push({ item: n, depth, rails, last });
      const list = (kids.get(n) ?? []).filter((k) => !seen.has(k)).sort((a, b) => a.number - b.number);
      list.forEach((k, i) => walk(k, depth + 1, depth ? [...rails, !last] : [], i === list.length - 1, new Set([...seen, k])));
    };
    walk(root, 0, [], true, new Set([root]));
    for (const m of members) done.add(m.item);
    const deepest = Math.max(...members.map((m) => m.depth));
    const atDepth = members.reduce((c, m) => ({ ...c, [m.depth]: (c[m.depth] ?? 0) + 1 }), {});
    const used = {};
    for (const m of members) {
      const letter = atDepth[m.depth] > 1 ? "abcdefghijklmnopqrstuvwxyz"[used[m.depth] = (used[m.depth] ?? -1) + 1] ?? "" : "";
      m.pos = `${m.depth + 1}${letter}/${deepest + 1}`;
      const p = m.depth && !m.item.outside ? parentOf(m.item) : null;
      if (p && p.state !== "OPEN") {
        let a = p;
        while (parentOf(a) && parentOf(a).state !== "OPEN" && a !== root) a = parentOf(a);
        m.warn = { parent: p.state.toLowerCase(), to: a.base };
      }
    }
    entries.push({ root, target: root.base, members });
  }
  return entries;
}

async function jira(cfg) {
  const jql = cfg.jql ?? `assignee = currentUser() AND status in (${cfg.statuses.map((s) => `"${s.id}"`).join(", ")})`;
  const r = await exec(cfg.cli ?? "jira", ["issue", "list", "-q", jql, "--plain", "--no-headers",
    "--columns", "key,status,summary", "--paginate", "25"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "jira failed");
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [key, status, ...rest] = line.split("\t").filter((s) => s !== "");
    const action = cfg.statuses.find((s) => s.id === status)?.action;
    return {
      key,
      title: rest.join(" "),
      url: `${cfg.site}/browse/${key}`,
      meta: status,
      status,
      preview: "jira-preview",
      action: action ? { label: fill(action.label, { key }), prompt: fill(action.prompt, { key }) } : null,
    };
  });
}

export default class Inbox extends View {
  init(_props, cx) {
    this.cfg = null;
    this.source = localStorage.getItem("source") === "jira" ? "jira" : "github";
    this.githubTab = localStorage.getItem("githubTab");
    this.jiraFilter = localStorage.getItem("jiraFilter") ?? "all";
    this.data = {};
    this.parents = {};
    try { this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsedStacks") ?? "[]")); } catch { this.collapsed = new Set(); }
    this.errors = {};
    this.loading = false;
    this.alerted = null;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.watchAgents();
    cx.timer.every(1000, () => this.watchAgents());
  }

  // Herdr plays a sound and toasts in its window when an agent is blocked or done; with the window in the
  // background, also post a macOS notification, once per agent and state.
  watchAgents() {
    const first = !this.alerted;
    this.alerted ??= new Map();
    const live = new Set();
    for (const a of agents()) {
      live.add(a.address);
      if (a.status !== "blocked" && a.status !== "done") { this.alerted.delete(a.address); continue; }
      if (this.alerted.get(a.address) === a.status) continue;
      this.alerted.set(a.address, a.status);
      if (!first && !appWindow().active) {
        const title = a.status === "blocked" ? `${this.waiting(a)}: ${this.agentName(a)}` : `Finished: ${this.agentName(a)}`;
        exec("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
          title, `${a.title} · ${a.space_name}`]);
      }
    }
    for (const address of this.alerted.keys()) if (!live.has(address)) this.alerted.delete(address);
  }

  // The tab's name, else (an unnamed tab, "4") the terminal's.
  agentName(a) {
    if (!/^\d+$/.test(a.tab_name)) return a.tab_name;
    return terminals().find((t) => t.address === a.address)?.name ?? `Tab ${a.tab_name}`;
  }

  waiting(a) {
    const kind = terminals().find((t) => t.address === a.address)?.report?.kind;
    return WAITING[kind] ?? "Needs you";
  }

  // Blocked agents, then ones that finished while you weren't looking ("done" turns "idle" once you look).
  needsYou(t, s) {
    const list = agents().filter((a) => a.status === "blocked" || a.status === "done")
      .sort((a, b) => (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1) || b.seq - a.seq);
    if (!list.length) return null;
    if (s.name !== "soft") return this.needsYouDense(t, s, list);
    return v_flex().mx(6).mb(8).pb(6).border_b(1).border_color(t.border)
      .child(h_flex().px(8).pb(4).gap(6).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("Needs you"))
        .child(div().text_size(10).text_color(t.dim).child(String(list.length))))
      .child(v_flex().id("needs-you").max_h(220).overflow_y_scrollbar().children(list.map((a) => {
        const color = a.status === "blocked" ? t.blocked : t.done;
        return v_flex().id(`ny-${a.address}`).px(8).py(6).gap(2).rounded(9).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => openSession(a.address))
          .child(h_flex().gap(7).items_center()
            .child(div().size(7).rounded(4).flex_none().bg(color)
              .when(a.status === "blocked", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1100 })))
            .child(div().text_size(11).font_semibold().text_color(t.accent).child(this.agentName(a)))
            .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(a.space_name))
            .child(div().text_size(10.5).text_color(color).child(a.status === "blocked" ? this.waiting(a) : "Finished")))
          .child(div().pl(14).text_size(12).text_color(t.foreground).truncate().child(a.title));
      })));
  }

  // Deck and LCARS: one line per agent, its state as a letter badge.
  needsYouDense(t, s, list) {
    const lcars = s.name === "lcars";
    return v_flex().mx(10).mb(8).pb(6).gap(1).border_b(1).border_color(t.border)
      .child(h_flex().px(2).pb(4).gap(6).items_center()
        .child(div().text_size(lcars ? 14 : 10).font_bold().when(lcars, (el) => el.font_family(s.head)).text_color(t.blocked).child(label(s, "Needs you")))
        .child(div().text_size(10).text_color(t.dim).child(String(list.length).padStart(2, "0"))))
      .child(v_flex().id("needs-you").max_h(220).overflow_y_scrollbar().children(list.map((a) => {
        const color = a.status === "blocked" ? t.blocked : t.done;
        return h_flex().id(`ny-${a.address}`).h(lcars ? 24 : 22).px(6).gap(7).items_center().rounded(rad(s, 9)).cursor_pointer()
          .border_l(lcars ? 0 : 2).border_color(color)
          .hover((el) => el.bg(t.hover))
          .on_click(() => openSession(a.address))
          .child(div().when(a.status === "blocked", (d) => d.loop("opacity", { from: 0.4, to: 1, period: 1100 }))
            .child(badge(s, t, LETTER[a.status], color)))
          .child(div().flex_none().max_w(110).truncate().text_size(11).font_bold().text_color(t.foreground).child(this.agentName(a)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(a.title))
          .child(div().flex_none().text_size(9.5).text_color(color).child(label(s, a.status === "blocked" ? this.waiting(a) : "Finished")));
      })));
  }

  // The item's session: its own, else (a PR) a ticket session its branch or title names.
  sessionOf(item) {
    return sessionFor(item.key) ?? (item.preview === "pr-preview" ? sessionIn(`${item.branch ?? ""} ${item.title}`) : null);
  }

  // A PR's CI dot and review decision.
  prStatus(t, item, s) {
    const ci = { pass: t.ansi2, fail: t.blocked, pending: t.working }[item.ci];
    const review = { APPROVED: t.ansi2, CHANGES_REQUESTED: t.blocked }[item.review] ?? t.dim;
    if (s.name !== "soft") {
      return h_flex().gap(3).items_center().flex_none()
        .when(Boolean(ci), (el) => el.child(div().when(item.ci === "pending", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1100 }))
          .child(badge(s, t, "C", ci))))
        .when(Boolean(REVIEW[item.review]), (el) => el.child(badge(s, t, "R", review, item.review !== "REVIEW_REQUIRED")));
    }
    return h_flex().gap(6).items_center().flex_none()
      .when(Boolean(ci), (el) => el.child(div().size(7).rounded(4).bg(ci)
        .when(item.ci === "pending", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1100 }))))
      .when(Boolean(REVIEW[item.review]), (el) => el.child(div().text_size(10.5).text_color(review).child(REVIEW[item.review])));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      this.cfg = await setup();
      const jobs = Object.fromEntries(this.cfg.github.tabs.map((g) => [g.id, async () => {
        const items = await gh(g.query, g.action);
        // A failed parent lookup leaves the stack short rather than failing the tab.
        try { this.parents[g.id] = await stackParents(items); } catch { this.parents[g.id] ??= []; }
        return items;
      }]));
      if (this.cfg.jira) jobs.jira = () => jira(this.cfg.jira);
      await Promise.all(Object.entries(jobs).map(async ([id, job]) => {
        try {
          this.data[id] = await job();
          delete this.errors[id];
        } catch (e) {
          this.errors[id] = String(e.message ?? e);
        }
      }));
      this.loading = false;
      cx.notify();
    });
  }

  // Open session when one exists, else the item's start action, else nothing.
  itemButton(t, item, s) {
    const session = this.sessionOf(item);
    if (!session && !item.action) return null;
    const status = session && statusOf(session);
    const dot = { working: t.working, blocked: t.blocked, done: t.done }[status] ?? t.dim;
    return h_flex().id(`act-${item.key}`).flex_none().gap(5).items_center().px(7).py(2).rounded(rad(s, 6)).border(1)
      .border_color(session ? `${dot}88` : t.border)
      .text_size(s.name === "soft" ? 10.5 : 9.5).text_color(session ? t.foreground : t.muted)
      .hover((s) => s.bg(t.solid).text_color(t.solid_foreground).border_color(t.solid))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (session) openSession(session);
        else cx.spawn(async () => { await startSession(item.key, item.action.prompt, item.url); });
      })
      .when(Boolean(session), (el) => el.child(div().size(6).rounded(3).bg(dot)
        .when(status === "working" || status === "blocked", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1100 }))))
      .child(label(s, session ? "Open session" : item.action.label));
  }

  preview(item) {
    openOverlay({
      mod: item.preview,
      props: { key: item.key, url: item.url, action: item.action ?? null },
      kind: "dialog", width: item.preview === "pr-preview" ? 0.85 : 820, height: 0.9,
    });
  }

  // `m`: the row's place in a stack, if it's in one.
  row(t, item, s, m) {
    const soft = s.name === "soft";
    const edge = { pass: t.ansi2, fail: t.blocked, pending: t.working }[item.ci]
      ?? { indeterminate: t.working }[item.status] ?? t.border;
    return v_flex()
      .id(`row-${item.key}`)
      .px(soft ? 12 : 9)
      .py(soft ? 9 : 5)
      .gap(soft ? 3 : 1)
      .rounded(rad(s, 9))
      .when(s.name === "deck", (el) => el.border_l(2).border_color(edge))
      .when(s.name === "lcars", (el) => el.rounded(0).rounded_l(6).border_l(5).border_color(edge === t.border ? t.ansi5 : edge))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.preview(item))
      .child(h_flex().gap(8).items_center()
        .children([m && this.position(t, s, m.pos)].filter(Boolean))
        .child(div().text_size(11).font_semibold().when(!soft, (el) => el.font_bold()).text_color(t.accent).child(item.key))
        .child(div().flex_1().text_size(soft ? 11 : 10).text_color(t.dim).truncate().child(soft ? item.meta ?? "" : label(s, item.meta ?? "")))
        .children([this.itemButton(t, item, s)].filter(Boolean)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(soft ? 12.5 : 11.5).text_color(soft ? t.foreground : t.muted).truncate().child(item.title))
        .when(item.preview === "pr-preview", (el) => el.child(this.prStatus(t, item, s))))
      .when(Boolean(m?.warn), (el) => el.child(div().text_size(soft ? 10.5 : 9.5).text_color(t.working).truncate()
        .child(label(s, `Parent ${m.warn.parent} · retarget to ${m.warn.to}`))));
  }

  // A stack position: "2/3", or "2a/3" beside a sibling.
  position(t, s, pos) {
    if (s.name !== "soft") return badge(s, t, pos, t.accent, false);
    return div().flex_none().px(5).rounded(4).bg(t.selected).text_size(10).font_semibold().text_color(t.muted).child(pos);
  }

  // A PR the stack sits on that this tab doesn't list: one dimmed line, marked merged or closed.
  parentRow(t, item, s, m) {
    const soft = s.name === "soft";
    const state = { MERGED: ["merged", t.ansi5], CLOSED: ["closed", t.blocked] }[item.state];
    return h_flex().id(`row-${item.key}`).flex_1().min_w(0).px(soft ? 12 : 9).py(soft ? 5 : 3).gap(8).items_center()
      .rounded(rad(s, 9)).opacity(0.65).cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click(() => this.preview(item))
      .child(this.position(t, s, m.pos))
      .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.muted).child(item.key))
      .child(div().flex_1().min_w(0).truncate().text_size(soft ? 11 : 10).text_color(t.dim).child(item.title))
      .child(div().flex_none().text_size(soft ? 10.5 : 9.5).text_color(state?.[1] ?? t.dim)
        .child(label(s, state?.[0] ?? item.meta ?? "")));
  }

  // Tree connectors for a member below the root: a column per level, │ where an ancestor has later siblings,
  // then ├ or └ into the row.
  rails(t, s, m) {
    const elbow = s.name === "soft" ? 17 : 12;
    const col = () => div().relative().flex_none().w(14);
    const line = () => div().absolute().left(6).w(1).bg(t.dim);
    return h_flex().flex_none().items_stretch()
      .children(m.rails.map((on) => col().when(on, (el) => el.child(line().top(0).bottom(0)))))
      .child(col()
        .child(line().top(0).when(m.last, (el) => el.h(elbow)).when(!m.last, (el) => el.bottom(0)))
        .child(div().absolute().left(6).top(elbow).w(8).h(1).bg(t.dim)));
  }

  stack(t, s, e) {
    const soft = s.name === "soft";
    const id = e.root.key;
    const open = !this.collapsed.has(id);
    const warns = e.members.filter((m) => m.warn).length;
    const toggle = (_e, cx) => {
      if (open) this.collapsed.add(id); else this.collapsed.delete(id);
      localStorage.setItem("collapsedStacks", JSON.stringify([...this.collapsed]));
      cx.notify();
    };
    return v_flex().id(`stack-${id}`).my(soft ? 3 : 0).pb(open ? 2 : 0).rounded(rad(s, 10)).border(1).border_color(t.border)
      .child(h_flex().id(`stack-head-${id}`).px(soft ? 10 : 8).py(soft ? 5 : 3).gap(6).items_center().cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click(toggle)
        .child(div().w(10).text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(div().flex_none().text_size(soft ? 11 : 10).font_semibold().text_color(t.muted).child(label(s, "Stack")))
        .child(div().flex_none().text_size(soft ? 11 : 10).text_color(t.dim).child(label(s, `${e.members.length} PRs`)))
        .child(div().flex_1().min_w(0).truncate().text_size(soft ? 11 : 10).text_color(t.dim).child(`→ ${e.target}`))
        .when(warns > 0, (el) => el.child(div().flex_none().text_size(soft ? 10.5 : 9.5).text_color(t.working)
          .child(label(s, warns > 1 ? `${warns} to retarget` : "retarget")))))
      .when(open, (el) => el.children(e.members.map((m) => h_flex().items_stretch().px(soft ? 4 : 2)
        .children([m.depth ? this.rails(t, s, m) : null].filter(Boolean))
        .child(m.item.outside ? this.parentRow(t, m.item, s, m) : this.row(t, m.item, s, m).flex_1().min_w(0)))));
  }

  // The data list shown: Jira's one list, or the chosen GitHub list.
  get tab() {
    if (this.source === "jira" && this.cfg?.jira) return "jira";
    const tabs = this.githubTabs_;
    return tabs.some((g) => g.id === this.githubTab) ? this.githubTab : tabs[tabs.length - 1]?.id;
  }

  chip(t, id, text, n, on, onClick) {
    const s = style();
    if (s.name === "lcars") {
      return h_flex().id(id).gap(5).h(20).px(10).items_center().rounded(10).bg(on ? t.ansi5 : t.raised)
        .hover((el) => el.opacity(0.85))
        .on_click(onClick)
        .child(div().font_family(s.head).text_size(13).text_color(on ? t.background : t.muted).child(label(s, text)))
        .when(n != null, (el) => el.child(div().font_family(s.head).text_size(12).text_color(on ? t.background : t.dim).child(String(n).padStart(2, "0"))));
    }
    return h_flex().id(id).gap(5).px(s.name === "deck" ? 7 : 9).py(s.name === "deck" ? 2 : 3).rounded(rad(s, 10)).border(1)
      .border_color(on ? t.accent : t.border)
      .when(on, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover))
      .on_click(onClick)
      .child(div().text_size(s.name === "deck" ? 10 : 11).text_color(on ? (s.name === "deck" ? t.accent : t.foreground) : t.muted).child(label(s, text)))
      .when(n != null, (el) => el.child(div().text_size(10).text_color(t.dim).child(String(n))));
  }

  get githubTabs_() {
    return this.cfg?.github.tabs ?? [];
  }

  githubTabs(t) {
    return h_flex().px(14).pb(6).gap(6).children(this.githubTabs_.map((g) =>
      this.chip(t, `gt-${g.id}`, g.label, this.data[g.id]?.length, g.id === this.tab,
        (_e, cx) => { this.githubTab = g.id; localStorage.setItem("githubTab", g.id); cx.notify(); })));
  }

  body(t, s) {
    const sub = this.tab === "jira" ? this.jiraFilters(t, this.data.jira ?? []) : this.githubTabs(t);
    return v_flex().flex_1().min_h(0).child(sub).child(this.list(t, s));
  }

  list(t, s) {
    if (this.errors[this.tab]) {
      return div().p(16).text_size(12).text_color(t.blocked).child(this.errors[this.tab]);
    }
    const all = this.data[this.tab];
    if (!all) return div().p(16).text_size(12).text_color(t.muted).child("Loading…");
    const items = this.tab === "jira" && this.jiraFilter !== "all" ? all.filter((i) => i.status === this.jiraFilter) : all;
    const entries = this.tab === "jira" ? items.map((item) => ({ item })) : stackEntries(items, this.parents[this.tab] ?? []);
    return items.length === 0
      ? div().p(16).text_size(12).text_color(t.muted).child("Nothing here. Nice.")
      : v_flex().id("rows").flex_1().px(s.name === "soft" ? 6 : 10).pb(10).gap(s.name === "soft" ? 0 : 3).overflow_y_scrollbar()
        .children(entries.map((e) => (e.item ? this.row(t, e.item, s) : this.stack(t, s, e))));
  }

  jiraFilters(t, all) {
    const filters = [{ id: "all", label: "All" }, ...this.cfg.jira.statuses];
    return h_flex().px(14).pb(6).gap(6).children(filters.map((f) => {
      const on = f.id === this.jiraFilter;
      const n = f.id === "all" ? all.length : all.filter((i) => i.status === f.id).length;
      return this.chip(t, `jf-${f.id}`, f.label, n, on,
        (_e, cx) => { this.jiraFilter = f.id; localStorage.setItem("jiraFilter", f.id); cx.notify(); });
    }));
  }

  // The panel's title and refresh control.
  header(t, s) {
    const busy = (el) => el.when(this.loading, (el) => el.loop("opacity", { from: 0.3, to: 1, period: 900 }));
    if (s.name === "soft") {
      return h_flex().px(14).pt(14).pb(10).items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Inbox"))
        .child(div().id("refresh").px(8).py(3).rounded(6).text_size(11).text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx))
          .child(busy(div()).child(this.loading ? "Syncing" : "Refresh")));
    }
    const lcars = s.name === "lcars";
    return h_flex().px(lcars ? 10 : 12).pt(lcars ? 12 : 11).pb(8).gap(8).items_center()
      .child(heading(s, t, "Inbox", "03.act"))
      .when(!lcars, (el) => el.child(div().flex_1()))
      .child(div().id("refresh").h(lcars ? 20 : 18).px(lcars ? 10 : 6).flex().items_center().rounded(lcars ? 10 : 1)
        .when(lcars, (el) => el.bg(this.loading ? t.ansi3 : t.ansi4).font_family(s.head).text_size(13).text_color(t.background))
        .when(!lcars, (el) => el.border(1).border_color(t.border).text_size(9.5).text_color(this.loading ? t.working : t.muted))
        .hover((el) => (lcars ? el.opacity(0.85) : el.border_color(t.accent).text_color(t.accent)))
        .on_click((_e, cx) => this.refresh(cx))
        .child(busy(div()).child(label(s, this.loading ? "Syncing" : "Refresh"))));
  }

  // GitHub or Jira: a segmented control (soft), bracketed tabs (deck) or pills (lcars).
  sources(t, s) {
    const soft = s.name === "soft";
    const lcars = s.name === "lcars";
    return h_flex().mx(soft ? 12 : 10).mb(8).p(soft ? 3 : 0).gap(soft ? 2 : lcars ? 4 : 0).rounded(rad(s, 9))
      .when(soft, (el) => el.bg(t.surface))
      .when(s.name === "deck", (el) => el.border(1).border_color(t.border))
      .children([{ id: "github", label: "GitHub" }, ...(this.cfg?.jira ? [{ id: "jira", label: "Jira" }] : [])].map((src) => {
        const ids = src.id === "jira" ? ["jira"] : this.githubTabs_.map((g) => g.id);
        const loaded = ids.filter((id) => this.data[id]);
        const n = loaded.length ? loaded.reduce((sum, id) => sum + this.data[id].length, 0) : null;
        const on = src.id === (this.tab === "jira" ? "jira" : "github");
        const tab = h_flex().id(`src-${src.id}`).flex_1().justify_center().items_center().gap(5)
          .on_click((_e, cx) => { this.source = src.id; localStorage.setItem("source", src.id); cx.notify(); });
        if (lcars) {
          return tab.h(22).rounded(11).bg(on ? t.accent : t.raised).hover((el) => el.opacity(0.85))
            .child(div().font_family(s.head).text_size(15).text_color(on ? t.background : t.muted).child(label(s, src.label)))
            .when(Boolean(n), (el) => el.child(div().font_family(s.head).text_size(13).text_color(on ? t.background : t.dim).child(String(n).padStart(2, "0"))));
        }
        if (!soft) {
          return tab.h(22).when(on, (el) => el.bg(t.selected).border_b(2).border_color(t.accent))
            .hover((el) => el.bg(t.hover))
            .child(div().text_size(10.5).font_bold().text_color(on ? t.accent : t.muted).child(label(s, src.label)))
            .when(Boolean(n), (el) => el.child(div().text_size(9.5).text_color(t.dim).child(String(n).padStart(2, "0"))));
        }
        return tab.py(5).rounded(7)
          .when(on, (el) => el.bg(t.raised))
          .hover((s) => s.bg(t.hover))
          .child(div().text_size(11.5).text_color(on ? t.foreground : t.muted).child(src.label))
          .when(Boolean(n), (el) => el.child(div().text_size(10).text_color(t.dim).child(String(n))));
      }));
  }

  render(cx) {
    const t = theme();
    const s = style();
    return v_flex()
      .size_full()
      .relative()
      .bg(t.chrome)
      .child(this.header(t, s))
      .children([this.needsYou(t, s)].filter(Boolean))
      .child(this.sources(t, s))
      .when(Boolean(this.cfg?.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).child(this.cfg.error)))
      .child(this.body(t, s))
      .when(s.name === "deck", (el) => el.children(brackets(t)));
  }
}
