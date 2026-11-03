// The design the shown layout asks for: "soft" (the field layout: rounded, light or dark),
// "deck" (dark, square, mono, amber) or "lcars" (black, orange pills). Mods keep their behaviour
// and read this only for shape and type: corner radius, label casing, the mono font.

import { shared } from "herdr";

const STYLES = {
  soft: { name: "soft", radius: 10, small: 6, caps: false, mono: null, tracking: 0 },
  deck: { name: "deck", radius: 2, small: 2, caps: true, mono: "JetBrains Mono", tracking: 0.6 },
  lcars: { name: "lcars", radius: 18, small: 10, caps: true, mono: "JetBrains Mono", tracking: 0.4 },
};

export function style() {
  return STYLES[shared("layout")] ?? STYLES.soft;
}

// A section or chip label in the style's casing.
export const label = (s, text) => (s.caps ? String(text).toUpperCase() : text);
