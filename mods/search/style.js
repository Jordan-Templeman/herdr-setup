// The design the shown layout asks for: "soft" (the field layout: rounded, light or dark),
// "deck" (dark, square, mono, amber) or "lcars" (black, orange pills). Mods keep their behaviour
// and read this only for shape and type: corner radius, label casing, the mono font.
// Soft mods keep their own drawing; the helpers below are for deck and lcars.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared } from "herdr";

const STYLES = {
  soft: { name: "soft", radius: 10, small: 6, caps: false, mono: null, tracking: 0, head: null },
  deck: { name: "deck", radius: 2, small: 2, caps: true, mono: "JetBrains Mono", tracking: 0.6, head: "JetBrains Mono" },
  lcars: { name: "lcars", radius: 18, small: 10, caps: true, mono: "JetBrains Mono", tracking: 0.4, head: "DIN Condensed" },
};

export function style() {
  return STYLES[shared("layout")] ?? STYLES.soft;
}

// A section or chip label in the style's casing.
export const label = (s, text) => (s.caps ? String(text).toUpperCase() : text);

// A corner radius: soft's own value as given, deck's squared off, lcars' rounded into a pill.
export const rad = (s, n) => (s.name === "deck" ? Math.min(n, 2) : s.name === "lcars" ? (n >= 9 ? 16 : 10) : n);

// Status as a letter: Working, Blocked (needs you), Done, Idle.
export const LETTER = { working: "W", blocked: "B", done: "D", idle: "I" };

// LCARS paints its bars from these theme colours, by a hash of the name.
export const LCARS = ["ansi3", "accent", "ansi5", "ansi4", "ansi11", "ansi13"];
export const lcarsColor = (t, i) => t[LCARS[Math.abs(i) % LCARS.length]];

// A badge: a filled square letter tile (deck) or a pill (lcars). `on` false draws it outlined.
export function badge(s, t, text, color, on = true) {
  const ink = t.background;
  if (s.name === "lcars") {
    return h_flex().flex_none().h(15).px(7).items_center().rounded(8)
      .when(on, (el) => el.bg(color)).when(!on, (el) => el.border(1).border_color(color))
      .font_family(s.head).text_size(12).text_color(on ? ink : color).child(label(s, text));
  }
  return h_flex().flex_none().h(14).min_w(14).px(3).justify_center().items_center().rounded(1)
    .when(on, (el) => el.bg(color)).when(!on, (el) => el.border(1).border_color(`${color}88`))
    .text_size(9.5).font_bold().text_color(on ? ink : color).child(label(s, text));
}

// A panel heading. Deck: "INBOX // 03.ACT" in amber caps with a dim tag. LCARS: an end cap, the title
// in condensed caps, and a bar to the edge carrying the tag.
export function heading(s, t, title, tag, color) {
  if (s.name === "lcars") {
    const c = color ?? t.accent;
    return h_flex().flex_1().min_w(0).h(20).gap(4).items_center()
      .child(div().w(18).h(20).flex_none().rounded_l(10).bg(c))
      .child(div().flex_none().px(2).font_family(s.head).text_size(18).text_color(c).child(label(s, title)))
      .child(h_flex().flex_1().min_w(12).h(20).px(8).justify_end().items_center().rounded_r(10).bg(c)
        .when(Boolean(tag), (el) => el.child(div().font_family(s.head).text_size(12).text_color(t.background).child(label(s, tag)))));
  }
  return h_flex().flex_none().gap(7).items_center()
    .child(div().text_size(11.5).font_bold().text_color(color ?? t.accent).child(label(s, title)))
    .when(Boolean(tag), (el) => el.child(div().text_size(9.5).text_color(t.dim).child(`// ${label(s, tag)}`)));
}

// Deck's corner brackets: short accent strokes at a box's top-left and bottom-right (the box is relative).
export function brackets(t, color, n = 9) {
  const c = color ?? t.accent;
  return [
    div().absolute().top(0).left(0).w(n).h(1).bg(c), div().absolute().top(0).left(0).w(1).h(n).bg(c),
    div().absolute().bottom(0).right(0).w(n).h(1).bg(c), div().absolute().bottom(0).right(0).w(1).h(n).bg(c),
  ];
}
