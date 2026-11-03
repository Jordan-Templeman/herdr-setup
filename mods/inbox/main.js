// The inbox: agents that need you, then your open PRs, PRs to review and Jira issues in one list.
// Click a row to preview it. Tabs, queries and start actions (a review, a ticket workflow) come from
// setup.json; an item with a running session (or a PR whose branch names a ticket's session) links back to it.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, openOverlay, agents, terminals, window as appWindow } from "herdr";
import { sessionFor, sessionIn, statusOf, openSession, startSession } from "./session.js";
import { setup, fill } from "./setup.js";

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
  needsYou(t) {
    const list = agents().filter((a) => a.status === "blocked" || a.status === "done")
      .sort((a, b) => (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1) || b.seq - a.seq);
    if (!list.length) return null;
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

  // The item's session: its own, else (a PR) a ticket session its branch or title names.
  sessionOf(item) {
    return sessionFor(item.key) ?? (item.preview === "pr-preview" ? sessionIn(`${item.branch ?? ""} ${item.title}`) : null);
  }

  // A PR's CI dot and review decision.
  prStatus(t, item) {
    const ci = { pass: t.ansi2, fail: t.blocked, pending: t.working }[item.ci];
    const review = { APPROVED: t.ansi2, CHANGES_REQUESTED: t.blocked }[item.review] ?? t.dim;
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
  itemButton(t, item) {
    const session = this.sessionOf(item);
    if (!session && !item.action) return null;
    const status = session && statusOf(session);
    const dot = { working: t.working, blocked: t.blocked, done: t.done }[status] ?? t.dim;
    return h_flex().id(`act-${item.key}`).flex_none().gap(5).items_center().px(7).py(2).rounded(6).border(1)
      .border_color(session ? `${dot}88` : t.border)
      .text_size(10.5).text_color(session ? t.foreground : t.muted)
      .hover((s) => s.bg(t.solid).text_color(t.solid_foreground).border_color(t.solid))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (session) openSession(session);
        else cx.spawn(async () => { await startSession(item.key, item.action.prompt); });
      })
      .when(Boolean(session), (el) => el.child(div().size(6).rounded(3).bg(dot)
        .when(status === "working" || status === "blocked", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 1100 }))))
      .child(session ? "Open session" : item.action.label);
  }

  row(t, item) {
    return v_flex()
      .id(`row-${item.key}`)
      .px(12)
      .py(9)
      .gap(3)
      .rounded(9)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => openOverlay({
        mod: item.preview,
        props: { key: item.key, url: item.url, action: item.action },
        kind: "dialog", width: item.preview === "pr-preview" ? 0.85 : 820, height: 0.9,
      }))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.accent).child(item.key))
        .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(item.meta ?? ""))
        .children([this.itemButton(t, item)].filter(Boolean)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).truncate().child(item.title))
        .when(item.preview === "pr-preview", (el) => el.child(this.prStatus(t, item))));
  }

  // The data list shown: Jira's one list, or the chosen GitHub list.
  get tab() {
    if (this.source === "jira" && this.cfg?.jira) return "jira";
    const tabs = this.githubTabs_;
    return tabs.some((g) => g.id === this.githubTab) ? this.githubTab : tabs[tabs.length - 1]?.id;
  }

  chip(t, id, label, n, on, onClick) {
    return h_flex().id(id).gap(5).px(9).py(3).rounded(10).border(1)
      .border_color(on ? t.accent : t.border)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(div().text_size(11).text_color(on ? t.foreground : t.muted).child(label))
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

  body(t) {
    const sub = this.tab === "jira" ? this.jiraFilters(t, this.data.jira ?? []) : this.githubTabs(t);
    return v_flex().flex_1().min_h(0).child(sub).child(this.list(t));
  }

  list(t) {
    if (this.errors[this.tab]) {
      return div().p(16).text_size(12).text_color(t.blocked).child(this.errors[this.tab]);
    }
    const all = this.data[this.tab];
    if (!all) return div().p(16).text_size(12).text_color(t.muted).child("Loading…");
    const items = this.tab === "jira" && this.jiraFilter !== "all" ? all.filter((i) => i.status === this.jiraFilter) : all;
    return items.length === 0
      ? div().p(16).text_size(12).text_color(t.muted).child("Nothing here. Nice.")
      : v_flex().id("rows").flex_1().px(6).pb(10).overflow_y_scrollbar().children(items.map((i) => this.row(t, i)));
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

  render(cx) {
    const t = theme();
    return v_flex()
      .size_full()
      .bg(t.chrome)
      .child(h_flex().px(14).pt(14).pb(10).items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Inbox"))
        .child(div().id("refresh").px(8).py(3).rounded(6).text_size(11).text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx))
          .child(div().when(this.loading, (el) => el.loop("opacity", { from: 0.3, to: 1, period: 900 }))
            .child(this.loading ? "Syncing" : "Refresh"))))
      .children([this.needsYou(t)].filter(Boolean))
      .child(h_flex().mx(12).mb(8).p(3).gap(2).rounded(9).bg(t.surface)
        .children([{ id: "github", label: "GitHub" }, ...(this.cfg?.jira ? [{ id: "jira", label: "Jira" }] : [])].map((src) => {
          const ids = src.id === "jira" ? ["jira"] : this.githubTabs_.map((g) => g.id);
          const loaded = ids.filter((id) => this.data[id]);
          const n = loaded.length ? loaded.reduce((sum, id) => sum + this.data[id].length, 0) : null;
          const on = src.id === (this.tab === "jira" ? "jira" : "github");
          return h_flex().id(`src-${src.id}`).flex_1().justify_center().gap(5).py(5).rounded(7)
            .when(on, (el) => el.bg(t.raised))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.source = src.id; localStorage.setItem("source", src.id); cx.notify(); })
            .child(div().text_size(11.5).text_color(on ? t.foreground : t.muted).child(src.label))
            .when(Boolean(n), (el) => el.child(div().text_size(10).text_color(t.dim).child(String(n))));
        })))
      .when(Boolean(this.cfg?.error), (el) => el.child(div().px(14).pb(6).text_size(11).text_color(t.blocked).child(this.cfg.error)))
      .child(this.body(t));
  }
}
