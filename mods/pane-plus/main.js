// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-plus" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// A Claude pane also gets a CLI / Chat switch: Chat opens the chat view beside the terminal,
// zoomed so it takes the terminal's place, and CLI closes it again. The terminal keeps running.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, terminals } from "herdr";
import { modes, chatFor, toChat, toCli } from "./mode.js";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-plus/${icon}.svg`).size(14));
  }

  // The switch's terminal: this pane's, if it holds a Claude session; or the one this chat pane stands in for.
  switchFor(p) {
    if (p.terminal) {
      return terminals().find((x) => x.address === p.terminal)?.records?.session || chatFor(p.terminal) || /claude/i.test(p.program?.name ?? "")
        ? { terminal: p.terminal, chat: false } : null;
    }
    const entry = Object.entries(modes()).find(([, m]) => m.chat === p.pane);
    return entry ? { terminal: entry[0], chat: true } : null;
  }

  modeSwitch(t, p, sw) {
    const option = (id, label, active, act) => div()
      .id(`ph-mode-${id}-${p.pane}`)
      .px(8)
      .h(20)
      .flex()
      .items_center()
      .rounded(5)
      .text_size(11)
      .text_color(active ? t.foreground : t.dim)
      .when(active, (el) => el.bg(t.background).font_medium())
      .when(!active, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!active) act(cx); })
      .child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.hover)
      .child(option("cli", "CLI", !sw.chat, () => toCli(sw.terminal)))
      .child(option("chat", "Chat", sw.chat, (cx) => toChat(p, cx)));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const sw = this.switchFor(p);
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(sw), (el) => el.child(this.modeSwitch(t, p, sw)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
