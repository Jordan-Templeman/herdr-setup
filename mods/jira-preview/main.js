// A Jira issue as a dialog: status, people, parent, description. Opened by the inbox
// with props { key, action }; the footer moves it to another status, adds a comment, and starts or
// reopens its agent session. setup.json's jira.dry_run logs those jira commands instead of running them.

import { openBeside } from "./beside.js";
import { View, div, svg } from "gpui-kit";
import { sessionFor, statusOf, openSession, startSession } from "./session.js";
import { style, label, rad, badge, heading, brackets } from "./style.js";
import { setup } from "./setup.js";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, spaces, run, theme, notify, props, closeOverlay, appHome } from "herdr";
import * as fs from "fs/promises";

const ICONS = "mods/workspace-chrome";

const ago = (iso) => {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

// Jira's description document (ADF) as markdown, for TextView.
function inline(nodes = []) {
  return nodes.map((n) => {
    if (n.type === "hardBreak") return "  \n";
    if (n.type === "mention") return n.attrs?.text ?? "";
    if (n.type === "inlineCard") return n.attrs?.url ?? "";
    if (n.type === "emoji") return n.attrs?.text ?? "";
    let t = n.text ?? "";
    for (const m of n.marks ?? []) {
      if (m.type === "code") t = `\`${t}\``;
      else if (m.type === "strong") t = `**${t}**`;
      else if (m.type === "em") t = `*${t}*`;
      else if (m.type === "strike") t = `~~${t}~~`;
      else if (m.type === "link") t = `[${t}](${m.attrs?.href})`;
    }
    return t;
  }).join("");
}

function adf(node, indent = "") {
  const kids = node?.content ?? [];
  switch (node?.type) {
    case "doc": return kids.map((k) => adf(k)).join("\n\n");
    case "paragraph": return indent + inline(kids);
    case "heading": return `${"#".repeat(node.attrs?.level ?? 2)} ${inline(kids)}`;
    case "bulletList":
    case "orderedList":
      return kids.map((item, i) => {
        const mark = node.type === "bulletList" ? "- " : `${i + 1}. `;
        const [first, ...rest] = (item.content ?? []).map((k) => adf(k, indent + "   ").trimStart());
        return [indent + mark + (first ?? ""), ...rest.map((r) => indent + "   " + r)].join("\n");
      }).join("\n");
    case "codeBlock": return "```" + (node.attrs?.language ?? "") + "\n" + kids.map((k) => k.text ?? "").join("") + "\n```";
    case "blockquote": return kids.map((k) => "> " + adf(k)).join("\n>\n");
    case "rule": return "---";
    case "panel": return kids.map((k) => adf(k)).join("\n\n");
    case "table":
      return kids.map((row, r) => {
        const cells = (row.content ?? []).map((c) => (c.content ?? []).map((k) => adf(k)).join(" ").replace(/\|/g, "\\|"));
        const line = `| ${cells.join(" | ")} |`;
        return r === 0 ? `${line}\n|${cells.map(() => " --- ").join("|")}|` : line;
      }).join("\n");
    default: return kids.length ? kids.map((k) => adf(k, indent)).join("\n\n") : inline([node]);
  }
}

export default class JiraPreview extends View {
  link(key) {
    return `${this.jira.site ?? ""}/browse/${key}`;
  }

  init(_props, cx) {
    this.s = style();
    this.issue = null;
    this.error = null;
    this.jira = {};
    this.transitions = null;
    this.panel = null; // "move" | "comment"
    this.target = null;
    this.busy = false;
    this.actionError = null;
    this.reply = TextareaState.new({ placeholder: "Add a comment (markdown)", rows: 4 });
    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const { key } = props() ?? {};
      this.jira = (await setup()).jira ?? {};
      this.loadTransitions(key, cx);
      const raw = await exec(this.jira.cli ?? "jira", ["issue", "view", key, "--raw"]);
      if (raw.code !== 0) {
        this.error = raw.stderr.trim() || "jira failed";
      } else {
        const f = JSON.parse(raw.stdout).fields;
        this.issue = {
          type: f.issuetype?.name,
          status: f.status?.name,
          category: f.status?.statusCategory?.key,
          priority: f.priority?.name,
          summary: f.summary,
          parent: f.parent ? `${f.parent.key} · ${f.parent.fields?.summary ?? ""}` : null,
          assignee: f.assignee?.displayName ?? "Unassigned",
          reporter: f.reporter?.displayName,
          updated: `${ago(f.updated)} · created ${ago(f.created)}`,
          labels: (f.labels ?? []).join(", "),
          description: f.description ? adf(f.description).trim() : "",
        };
      }
      cx.notify();
    });
  }

  // The jira CLI has no transition list, so ask the REST API as the CLI's user (`jira me`, $JIRA_API_TOKEN).
  loadTransitions(key, cx) {
    cx.spawn(async (cx) => {
      const me = await exec(this.jira.cli ?? "jira", ["me"]);
      const r = me.code === 0 ? await exec("/bin/sh", ["-c", 'curl -sf -u "$1:$JIRA_API_TOKEN" "$2"', "sh", me.stdout.trim(),
        `${this.jira.site}/rest/api/3/issue/${key}/transitions`]) : me;
      this.transitions = r.code === 0
        ? JSON.parse(r.stdout).transitions.map((x) => ({ name: x.name, to: x.to?.name, category: x.to?.statusCategory?.key }))
        : { error: r.stderr.trim() || "Couldn't list transitions (is JIRA_API_TOKEN set?)" };
      cx.notify();
    });
  }

  // Runs a jira command that changes the ticket, or with jira.dry_run logs it to inspect/jira-dry-run.log.
  async jiraWrite(args) {
    const cli = this.jira.cli ?? "jira";
    if (!this.jira.dry_run) return exec(cli, args);
    const line = [cli, ...args].map((a) => (/^[\w./:-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
    const file = `${appHome()}/inspect/jira-dry-run.log`;
    await fs.mkdir(`${appHome()}/inspect`, { recursive: true });
    const before = await fs.readFile(file, "utf8").catch(() => "");
    await fs.writeFile(file, `${before}${new Date().toISOString()} ${line}\n`);
    notify({ title: "Dry run: jira not called", body: line, level: "info", timeout: 5000 });
    return { code: 0, stdout: "", stderr: "" };
  }

  // kind: "move" transitions to this.target; "comment" posts the composer's text.
  submit(kind, cx) {
    const { key } = props();
    const body = this.reply.value().trim();
    if (kind === "comment" && !body) { this.actionError = "Write something first."; cx.notify(); return; }
    if (kind === "move" && !this.target) { this.actionError = "Pick a status first."; cx.notify(); return; }
    this.busy = true;
    this.actionError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = kind === "move"
        ? await this.jiraWrite(["issue", "move", key, this.target.name])
        : await this.jiraWrite(["issue", "comment", "add", key, body, "--no-input"]);
      this.busy = false;
      if (r.code !== 0) this.actionError = r.stderr.trim() || r.stdout.trim() || "jira failed";
      else {
        if (!this.jira.dry_run) notify({ title: kind === "move" ? `Moved to ${this.target.to ?? this.target.name}` : "Comment added", body: key, level: "info", timeout: 3000 });
        if (kind === "comment") this.reply.set_value("");
        this.panel = null;
        this.target = null;
        if (!this.jira.dry_run) this.load(cx);
      }
      cx.notify();
    });
  }

  // The open move or comment panel above the footer.
  actionPanel(t, button) {
    const act = (id, icon, label) => button(id, icon, this.busy ? "Sending…" : label, true, (_e, cx) => { if (!this.busy) this.submit(this.panel, cx); });
    const error = (el) => el.when(Boolean(this.actionError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.actionError)));
    const panel = v_flex().px(20).py(12).gap(8).border_t(1).border_color(t.border).bg(t.surface);
    if (this.panel === "comment") {
      return error(panel
        .child(div().id("reply").rounded(rad(this.s, 8)).border(1).border_color(t.border).bg(t.popover).p(8)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.reply).h(96).text_size(12.5).text_color(t.foreground))))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.jira.dry_run ? "Dry run · logs the command" : "Posts as you"))
          .child(act("post", "square-pen", "Add comment")));
    }
    const list = this.transitions;
    const current = this.issue?.status;
    const colors = { indeterminate: t.working, done: t.done };
    return error(panel
      .child(!list ? div().text_size(12).text_color(t.muted).child("Loading statuses…")
        : list.error ? div().text_size(12).text_color(t.blocked).child(list.error)
        : h_flex().flex_wrap().gap(6).children(list.filter((x) => x.to !== current).map((x) => {
          const on = this.target?.name === x.name;
          return h_flex().id(`tr-${x.name}`).gap(5).items_center().px(9).py(3).rounded(rad(this.s, 10)).border(1)
            .border_color(on ? t.accent : t.border)
            .when(on, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.target = x; this.actionError = null; cx.notify(); })
            .child(div().size(6).rounded(rad(this.s, 3)).bg(colors[x.category] ?? t.muted))
            .child(div().text_size(11.5).text_color(on ? t.foreground : t.muted).child(label(this.s, x.name)))
            .when(Boolean(x.to) && x.to !== x.name, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`→ ${x.to}`)));
        }))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.jira.dry_run ? "Dry run · logs the command" : `From ${current ?? "?"}`))
        .when(Boolean(this.target), (el) => el.child(act("move", "chevron-right", `Move to ${this.target.to ?? this.target.name}`))));
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

  // As a dialog, closes it; as a pane beside a chat, the pane header closes it instead.
  close() {
    if (props()?.overlay) closeOverlay(props().overlay);
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
      .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(value));
  }

  render() {
    const t = theme();
    const st = (this.s = style());
    const soft = st.name === "soft";
    const lcars = st.name === "lcars";
    const { key } = props() ?? {};
    const i = this.issue;
    const statusColor = { indeterminate: t.working, done: t.done }[i?.category] ?? t.muted;

    const header = h_flex().px(lcars ? 12 : 20).py(12).gap(10).items_center().border_b(1).border_color(t.border)
      .when(soft, (el) => el.child(div().text_size(12).text_color(t.muted).child(i?.type ?? "Issue")))
      .when(!soft, (el) => el.child(heading(st, t, i?.type ?? "Issue", lcars ? "09-tkt" : "09.tkt", lcars ? t.ansi4 : t.accent)))
      .child(div().text_size(12.5).font_semibold().text_color(soft ? t.foreground : t.accent).when(lcars, (el) => el.font_family(st.head).text_size(17))
        .child(key ?? ""))
      .when(Boolean(i?.status), (el) => el.child(soft
        ? div().px(8).py(2).rounded(rad(this.s, 6)).bg(`${statusColor}22`).text_size(11).text_color(statusColor).child(i.status)
        : badge(st, t, i.status, statusColor)))
      .when(Boolean(i?.priority), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(label(st, i.priority))))
      .when(!lcars, (el) => el.child(div().flex_1()))
      .when(Boolean(key), (el) => el.child(this.copyLink(t, this.link(key), "jira-preview")))
      .when(Boolean(props()?.overlay), (el) => el.child(div().id("beside").px(8).py(4).rounded(rad(this.s, 6)).text_size(11.5).text_color(t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click(async () => {
          const { key } = props();
          await openBeside("jira-preview", { key }, key);
          this.close();
        })
        .child(label(this.s, "Open beside"))))
      .when(Boolean(props()?.overlay), (el) => el.child(div().id("close").p(4).rounded(rad(this.s, 6)).hover((s) => s.bg(t.hover))
        .on_click(() => this.close())
        .child(svg(`${ICONS}/x.svg`).size(15).text_color(t.muted))));

    let body;
    if (this.error) body = div().p(20).text_size(12.5).text_color(t.blocked).child(this.error);
    else if (!i) body = div().p(20).text_size(12.5).text_color(t.muted)
      .child(div().loop("opacity", { from: 0.35, to: 1, period: 900 }).child("Loading ticket…"));
    else body = v_flex().id("body").flex_1().min_h(0).px(20).py(16).gap(16).overflow_y_scrollbar()
      .child(div().text_size(18).font_semibold().text_color(t.foreground).when(lcars, (el) => el.font_family(st.head).text_size(24)).child(i.summary))
      .child(v_flex().gap(7).children([
        this.field(t, "Epic", i.parent),
        this.field(t, "Assignee", i.assignee),
        this.field(t, "Reporter", i.reporter),
        this.field(t, "Updated", i.updated),
        this.field(t, "Labels", i.labels),
      ].filter(Boolean)))
      .child(v_flex().gap(6)
        .child(soft ? div().text_size(12).text_color(t.dim).child("Description") : heading(st, t, "Description", null, lcars ? t.ansi5 : t.muted))
        .child(i.description
          ? TextView.markdown(`desc-${key}`, i.description)
          : div().text_size(12.5).text_color(t.muted).child(label(st, "No description."))));

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

    const toggle = (id, icon, label) => button(id, this.panel === id ? "chevron-down" : icon, label, false,
      (_e, cx) => { this.panel = this.panel === id ? null : id; this.target = null; this.actionError = null; cx.notify(); });
    const footer = h_flex().px(20).py(12).gap(8).justify_end().border_t(1).border_color(t.border)
      .when(Boolean(i), (el) => el.child(toggle("move", "chevron-right", "Move")).child(toggle("comment", "square-pen", "Comment")))
      .child(div().flex_1())
      .child(button("open", "file-text", "Open in Jira", false, () => { exec("open", [this.link(key)]); this.close(); }))
      .children([this.sessionButton(button)].filter(Boolean));

    return v_flex().size_full().relative().bg(t.popover).child(header).child(body)
      .when(Boolean(this.panel) && Boolean(i), (el) => el.child(this.actionPanel(t, button)))
      .child(footer)
      .when(st.name === "deck", (el) => el.children(brackets(t, t.accent, 14)));
  }
}
