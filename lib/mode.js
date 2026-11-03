// The CLI / Chat switch for a Claude pane. Chat opens the chat view beside the terminal, zoomed so
// it takes the terminal's place; CLI closes it. The terminal keeps running either way.
// Shared state "pane-plus.chat": { [terminal]: { chat, pane } }, the chat pane and the terminal's.
// Lives in lib/ and is symlinked into each mod that uses it.
import { panes, run, shared, setShared } from "herdr";

export const modes = () => shared("pane-plus.chat") ?? {};

function setMode(terminal, value) {
  const next = { ...modes() };
  if (value) next[terminal] = value;
  else delete next[terminal];
  setShared("pane-plus.chat", next);
}

const alive = (pane) => Boolean(pane) && panes().some((q) => q.pane === pane);

// The chat view open for this terminal, if any.
export const chatFor = (terminal) => (alive(modes()[terminal]?.chat) ? modes()[terminal].chat : null);

// p: the terminal's pane (from panes()).
export function toChat(p, cx) {
  const open = chatFor(p.terminal);
  if (open) {
    run("pane.zoom", { pane: open });
    return run("pane.focus", { pane: open });
  }
  // A second click while the first view is still opening would open another.
  const pending = shared("pane-plus.pending") ?? {};
  if (pending[p.terminal] && Date.now() - pending[p.terminal] < 2000) return;
  setShared("pane-plus.pending", { ...pending, [p.terminal]: Date.now() });

  const before = new Set(panes().map((q) => q.pane));
  run("pane.split", { pane: p.pane, direction: "right", mod: "chat", props: { terminal: p.terminal } });
  let tries = 0;
  const zoom = () => {
    const chat = panes().find((q) => q.mod === "chat" && q.tab === p.tab && !before.has(q.pane));
    if (chat) {
      setMode(p.terminal, { chat: chat.pane, pane: p.pane });
      run("pane.zoom", { pane: chat.pane });
      run("pane.focus", { pane: chat.pane });
    } else if (++tries < 40) cx.timer.after(50, zoom);
  };
  zoom();
}

export function toCli(terminal) {
  const m = modes()[terminal];
  if (!m) return false;
  setMode(terminal, null);
  run("pane.close", { pane: m.chat });
  run("pane.focus", { pane: m.pane });
  return true;
}

// Closes the chat view the switch opened for a terminal that has ended.
export function closeWith(terminal) {
  const m = modes()[terminal];
  if (!m) return false;
  setMode(terminal, null);
  run("pane.close", { pane: m.chat });
  return true;
}
