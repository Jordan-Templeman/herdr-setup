import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings } from "herdr";
import { style } from "./style.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const look = style();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const tabColors = [t.ansi11, t.ansi5, t.ansi4, t.ansi12];
      const tone = look.name === "lcars" ? (c.active ? t.accent : tabColors[i % tabColors.length]) : null;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .when(look.name === "deck", el => el.h(26).px(9).gap(6).rounded(0).text_size(11.5).border(0).border_b(2)
          .border_color(c.active ? t.accent : t.chrome).bg(c.active ? t.surface : t.chrome))
        .when(look.name === "lcars", el => el.h(26).px(12).gap(6).rounded(13).border(0).bg(tone).text_color("#000000")
          .font_family("DIN Condensed").text_size(16))
        .hover(s => look.name === "lcars" ? s.opacity(0.82) : s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(look.name === "lcars", el => el.child(div().pt(2).child(String(i + 1).padStart(2, "0"))))
        .when(look.name === "lcars" && /^\d+$/.test(name), el => el.pr(4))
        .when(Boolean(program?.icon) && look.name !== "lcars", el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .when(!(look.name === "lcars" && /^\d+$/.test(name)), el => el.child(div().max_w(170).truncate().when(look.name === "lcars", el => el.pt(2)).child(look.caps ? String(c.zoomed ? `${name} Z` : name).toUpperCase() : c.zoomed ? `${name} Z` : name)))
        .when(look.name === "lcars" && /^\d+$/.test(name) && c.zoomed, el => el.child(div().pt(2).child("Z")))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome-plus/spinner.svg").size(12).flex_none().text_color(look.name === "lcars" ? "#000000" : t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(look.name === "deck" ? 0 : 3).bg(look.name === "lcars" ? "#000000" : t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(look.name === "lcars" ? "#000000" : t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // PR (pr-files) is ours, so it is always offered.
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "pr"];
    this.syncPanel(space, panel, body, enabled);
    // One control in the bar's look: soft keeps the shipped button, Deck a square chip with an
    // amber edge when on, LCARS a colour pill.
    const chip = (id, on, text, icon, color, action) => {
      const el = h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(action);
      if (look.name === "deck") return el.h(22).px(7).rounded(0).text_size(10.5).border(1).border_color(on ? t.accent : t.border)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.accent : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .when(Boolean(icon), el => el.child(svg(icon).size(12))).child(text.toUpperCase());
      if (look.name === "lcars") return el.h(24).px(12).rounded(12).bg(on ? color : t.raised).text_color(on ? "#000000" : color)
        .font_family("DIN Condensed").text_size(15).hover(s => s.opacity(0.82)).child(div().pt(2).child(text.toUpperCase()));
      return icon ? el.child(svg(icon).size(14)).when(Boolean(text), el => el.child(text)) : el.child(text);
    };
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return chip(`panel-${id}`, on, label, icon, { files: t.ansi4, changes: t.ansi12, pr: t.ansi3 }[id], () => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
      });
    };
    // Pond, inbox and focus mode (pane-plus hides the side blocks and remembers which).
    const visible = (id) => { const n = find(root, id); return Boolean(n && !n.hidden); };
    const focus = Boolean(shared("pane-plus.focus"));
    const toggle = (id, text, icon, color, on, action, tip) => look.name === "soft"
      ? div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click(action).tooltip(tip).child(svg(icon).size(14))
      : chip(id, on, text, look.name === "deck" ? null : icon, color, action).tooltip(tip);
    const toggles = h_flex().gap(look.name === "soft" ? 1 : 4).flex_none().items_center()
      .when(Boolean(find(root, "field")), el => el.child(toggle("toggle-pond", "Pond", "mods/workspace-chrome-plus/layers.svg", t.ansi3, visible("field") && !focus,
        () => run("layout.toggle", { id: "field" }), "Pond  \u2325\u2318P")))
      .when(Boolean(find(root, "inbox")), el => el.child(toggle("toggle-inbox", "Inbox", "mods/workspace-chrome-plus/panel-right.svg", t.ansi5, visible("inbox") && !focus,
        () => run("layout.toggle", { id: "inbox" }), "Inbox  \u2325\u2318I")))
      .child(toggle("toggle-focus", "Focus", "mods/workspace-chrome-plus/square.svg", t.blocked, focus,
        () => run("pane-plus.zen"), "Focus mode  \u2325\u2318F"));
    const sep = () => look.name === "deck" ? div().w(1).h(14).mx(4).flex_none().bg(t.border) : div().w(look.name === "lcars" ? 6 : 4).flex_none();
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(look.name === "lcars" ? 5 : 3).items_center().bg(t.chrome).border_b(look.name === "lcars" ? 0 : 1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(look.name === "lcars"
        ? chip("tab-new", true, "+", null, t.ansi5, () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))
        : button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).when(look.name === "deck", el => el.size(22).rounded(0).hover(s => s.text_color(t.accent))))
      .child(sep())
      .child(toggles)
      .child(sep())
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(Boolean(find(body, "pr")), el => el.child(panelButton("pr", "PR", "mods/pr-files/pr.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-plus/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-plus/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-plus/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
