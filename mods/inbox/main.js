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
const SEARCH = `query($q: String!) {
  search(query: $q, type: ISSUE_ADVANCED, first: 30) {
    nodes { ... on PullRequest { number title url isDraft updatedAt headRefName reviewDecision author { login } repository { name }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }
  }
}`;

async function gh(q, action) {
  const r = await exec("gh", ["api", "graphql", "-f", `q=${q}`, "-f", `query=${SEARCH}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "gh failed");
  return JSON.parse(r.stdout).data.search.nodes.filter((p) => p.number).map((p) => ({
    key: `${p.repository.name}#${p.number}`,
    title: p.title,
    url: p.url,
    branch: p.headRefName,
    ci: CI[p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] ?? null,
    review: p.isDraft ? null : p.reviewDecision ?? null,
    meta: [p.isDraft ? "draft" : null, p.author?.login, ago(p.updatedAt)].filter(Boolean).join(" · "),
    action: action ? { label: fill(action.label, { url: p.url }), prompt: fill(action.prompt, { url: p.url }) } : null,
    preview: "pr-preview",
  }));
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
      const jobs = Object.fromEntries(this.cfg.github.tabs.map((g) => [g.id, () => gh(g.query, g.action)]));
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
        else cx.spawn(async () => { await startSession(item.key, item.action.prompt); });
      })
      .when(Boolean(session), (el) => el.child(div().size(6).rounded(3).bg(dot)
        .when(status === "working" || status === "blocked", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1100 }))))
      .child(label(s, session ? "Open session" : item.action.label));
  }

  row(t, item, s) {
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
      .on_click(() => openOverlay({
        mod: item.preview,
        props: { key: item.key, url: item.url, action: item.action },
        kind: "dialog", width: item.preview === "pr-preview" ? 0.85 : 820, height: 0.9,
      }))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11).font_semibold().when(!soft, (el) => el.font_bold()).text_color(t.accent).child(item.key))
        .child(div().flex_1().text_size(soft ? 11 : 10).text_color(t.dim).truncate().child(soft ? item.meta ?? "" : label(s, item.meta ?? "")))
        .children([this.itemButton(t, item, s)].filter(Boolean)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(soft ? 12.5 : 11.5).text_color(soft ? t.foreground : t.muted).truncate().child(item.title))
        .when(item.preview === "pr-preview", (el) => el.child(this.prStatus(t, item, s))));
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
    return items.length === 0
      ? div().p(16).text_size(12).text_color(t.muted).child("Nothing here. Nice.")
      : v_flex().id("rows").flex_1().px(s.name === "soft" ? 6 : 10).pb(10).gap(s.name === "soft" ? 0 : 3).overflow_y_scrollbar()
        .children(items.map((i) => this.row(t, i, s)));
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
