import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, machines, theme, run, window, keys } from "herdr";
import { style } from "./style.js";

export default class WorkspaceStatus extends View {
  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const look = style().name;
    if (look === "deck") return this.deck(t, space, list, needs);
    if (look === "lcars") return this.lcars(t, space, list, needs);
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome-plus/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }

  // Deck: a statusline of bracketed segments.
  deck(t, space, list, needs) {
    const seg = (key, value, color) => h_flex().gap(5).items_center().flex_none()
      .child(div().text_color(t.dim).child("["))
      .child(div().text_color(t.dim).child(key))
      .child(div().min_w(0).truncate().text_color(color ?? t.foreground).child(value))
      .child(div().text_color(t.dim).child("]"));
    const working = list.filter(a => a.status === "working").length;
    return h_flex().size_full().px(12).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(10.5)
      .child(div().size(6).flex_none().bg(needs ? t.blocked : working ? t.working : t.done))
      .child(seg("HOST", (space?.machine ?? "local").toUpperCase(), t.done))
      .when(Boolean(space?.branch), el => el.child(seg("BR", space.branch, t.accent)))
      .child(seg("AGT", `${String(list.length).padStart(2, "0")} \u00b7 ${working} RUN`))
      .when(needs > 0, el => el.child(seg("ALERT", `${needs} NEEDS YOU`, t.blocked)))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).hover(s => s.text_color(t.accent)).on_click(() => run("app.palette")).child(this.hint(t).toUpperCase()));
  }

  // LCARS: numbered readouts over a segmented bar.
  lcars(t, space, list, needs) {
    const count = (s) => String(list.filter(a => a.status === s).length).padStart(2, "0");
    const read = (text, color) => div().flex_none().text_color(color).child(text);
    const remote = machines().filter(m => m.name).length;
    return v_flex().size_full().bg(t.chrome).font_family("DIN Condensed").text_size(14)
      .child(h_flex().flex_1().px(6).gap(14).items_center()
        .child(read(`${count("working")} WORKING`, t.ansi4))
        .child(read(`${String(needs).padStart(2, "0")} NEED YOU`, needs ? t.blocked : t.dim))
        .child(read(`${count("done")} DONE`, t.ansi11))
        .child(read(`${String(remote + 1).padStart(2, "0")} MACHINES`, t.ansi5))
        .when(Boolean(space?.branch), el => el.child(div().min_w(0).truncate().text_color(t.accent).child(space.branch.toUpperCase())))
        .child(div().flex_1())
        .child(div().id("palette").text_color(t.accent).hover(s => s.opacity(0.8)).on_click(() => run("app.palette")).child(this.hint(t).toUpperCase())))
      .child(h_flex().h(6).gap(4).flex_none()
        .child(div().w(90).h_full().bg(t.ansi5))
        .child(div().flex_1().h_full().bg(t.ansi4))
        .child(div().w(60).h_full().bg(t.ansi11))
        .child(div().w(30).h_full().bg(t.accent).rounded_r(3)));
  }
}
