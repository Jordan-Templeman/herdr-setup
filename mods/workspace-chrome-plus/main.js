import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, spaces, agents } from "herdr";
import { style } from "./style.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const s = style();
    if (s.name === "deck") return this.deck(theme(), narrow());
    if (s.name === "lcars") return this.lcars(theme(), narrow());
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/workspace-chrome-plus/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome-plus/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome-plus/sidebar.svg").size(15), toggleSidebar)));
  }

  // Deck: a mono header strip with a numbered tag; the footer as terse command rows.
  deck(t, collapsed) {
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    const icon = (id, name, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center().text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.accent)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
      .child(svg(`mods/workspace-chrome-plus/${name}.svg`).size(13));
    if (props()?.footer) {
      const row = (id, glyph, text, action) => h_flex().id(id).h(24).px(8).gap(8).items_center().text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_click(action)
        .child(svg(`mods/workspace-chrome-plus/${glyph}.svg`).size(12))
        .when(!collapsed, el => el.child(text));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(6).py(6).gap(1).text_size(11)
        .child(row("settings", "settings", "SETTINGS", () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().text_color(t.accent).child("// UPDATE"))))
        .child(row("machine", "plus", "ADD MACHINE", () => run("mod.open", { name: "machine-add" })));
    }
    return h_flex().size_full().bg(t.chrome).border_b(1).border_color(t.border).pl(collapsed ? 6 : 14).pr(8).gap(2).items_center().text_size(12)
      .when(mac && !collapsed, el => el.pl(80))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center()
        .child(image("frame/welcome/herdr.png").size(16).rounded(2))
        .child(div().font_bold().text_color(t.foreground).child("HERDR"))
        .child(div().text_size(10).text_color(t.dim).child("// 00.SYS"))))
      .when(!collapsed, el => el.child(icon("search", "search", () => run("mod.open", { name: "picker" }))))
      .when(!(collapsed && mac), el => el.child(icon("sidebar-toggle", "sidebar", toggleSidebar)));
  }

  // LCARS: the sidebar's top elbow (an orange bar curving down into the left rail) and its bottom one.
  lcars(t, collapsed) {
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    const orange = t.accent, rail = 12;
    const cond = (el) => el.font_family("DIN Condensed").text_color("#000000");
    if (props()?.footer) {
      const pill = (id, color, text, action) => cond(h_flex().id(id).h(22).px(10).gap(6).items_center().justify_end().bg(color).rounded_r(11)
        .text_size(14).hover(s => s.opacity(0.8)).cursor_pointer().on_click(action))
        .child(text);
      const busy = agents().filter(a => a.status === "working").length;
      return v_flex().size_full().bg(t.chrome).pt(4).gap(3)
        .child(h_flex().gap(3)
          .child(div().w(rail).h(22).flex_none().bg(t.ansi5))
          .child(pill("settings", t.ansi5, collapsed ? "⚙" : updates().app.ready ? "MENU · UPDATE" : "MENU", () => run("app.settings")).flex_1()))
        .child(h_flex().gap(3)
          .child(div().w(rail).h(22).flex_none().bg(t.ansi11))
          .child(pill("machine", t.ansi11, collapsed ? "+" : "ADD MACHINE", () => run("mod.open", { name: "machine-add" })).flex_1()))
        // The bottom elbow: the rail turning right into a bar.
        .child(div().flex_1().min_h(6).relative().bg(orange).rounded_bl(22)
          .child(div().absolute().top(0).left(rail).right(0).bottom(6).bg(t.chrome).rounded_bl(10))
          .when(!collapsed, el => el.child(cond(div().absolute().right(8).bottom(-1).text_size(11)).child(busy ? `${String(busy).padStart(2, "0")} ACTIVE` : "STANDING BY"))));
    }
    const n = String(spaces().length).padStart(2, "0");
    return div().size_full().bg(t.chrome).relative()
      // The top elbow: a bar with a quarter-round outer corner and an inner curve where the rail leaves it.
      .child(div().absolute().inset(0).bg(orange).rounded_tl(24))
      .child(div().absolute().left(rail).right(0).bottom(0).h(8).bg(t.chrome).rounded_tl(10))
      .child(h_flex().absolute().left(0).right(0).top(0).bottom(8).pr(8).gap(4).items_center().justify_end()
        .when(!collapsed, el => el
          .child(cond(div().flex_1().text_right().text_size(17).pt(3)).child(`HERDR ${n}`))
          .child(div().id("search").px(6).h(20).rounded(10).bg("#000000").text_color(orange).flex().items_center()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("mod.open", { name: "picker" }))
            .hover(s => s.opacity(0.8)).child(svg("mods/workspace-chrome-plus/search.svg").size(12))))
        .when(!(collapsed && mac), el => el.child(div().id("sidebar-toggle").px(6).h(20).rounded(10).bg("#000000").text_color(orange).flex().items_center()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(toggleSidebar)
          .hover(s => s.opacity(0.8)).child(svg("mods/workspace-chrome-plus/sidebar.svg").size(12)))));
  }
}
