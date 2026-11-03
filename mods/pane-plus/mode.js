// The CLI / Chat switch for a Claude agent. In chat mode the agent's tab holds its chat view (the
// chat mod, props {terminal}) and the terminal runs in a tab of its own, settled out of the lists;
// CLI brings that tab back and shows it. Not zoomed, so previews open beside the chat.
// Shared state "pane-plus.chat": { [terminal]: { chatTab, chatPane, cliTab, cli } }. Entries from
// the old zoomed view ({ chat, pane }) close on the next switch.
// Moving the terminal parks it, which ends the pane header that asked, so the pond (field) does
// the moving: "pane-plus.convert": { [terminal]: { at, show, by } } asks it to.
// Lives in lib/ and is copied into each mod that uses it (bin/sync-shared).
import { panes, spaces, focused, run, shared, setShared } from "herdr";

export const modes = () => shared("pane-plus.chat") ?? {};

function setMode(terminal, value) {
  const next = { ...modes() };
  if (value) next[terminal] = value;
  else delete next[terminal];
  setShared("pane-plus.chat", next);
}

const alive = (pane) => Boolean(pane) && panes().some((q) => q.pane === pane);
const tabOf = (id) => spaces().flatMap((s) => s.tabs).find((tb) => tb.id === id);
const chatPaneOf = (m) => m?.chatPane ?? m?.chat;

// The chat view open for this terminal, if any.
export const chatFor = (terminal) => (alive(chatPaneOf(modes()[terminal])) ? chatPaneOf(modes()[terminal]) : null);

// The terminal a chat pane stands for.
export const terminalFor = (pane) => Object.entries(modes()).find(([, m]) => chatPaneOf(m) === pane)?.[0] ?? null;

function showChat(terminal, m) {
  run("tab.select", { id: m.chatTab });
  run("pane.focus", { pane: m.chatPane });
  if (tabOf(m.cliTab)) run("tab.settle", { id: m.cliTab });
  if (m.cli) setMode(terminal, { ...m, cli: false });
}

// Asks the pond to move a terminal into chat mode: show it when it's done if `show`.
export function requestChat(terminal, show) {
  const pending = shared("pane-plus.pending") ?? {};
  if (pending[terminal] && Date.now() - pending[terminal] < 5000) return;
  setShared("pane-plus.convert", { ...(shared("pane-plus.convert") ?? {}), [terminal]: { at: Date.now(), show } });
}

export function toChat(terminal) {
  const m = modes()[terminal];
  if (m?.chatTab && alive(m.chatPane) && tabOf(m.cliTab)) return showChat(terminal, m);
  if (m) {
    if (m.chat) run("pane.close", { pane: m.chat });
    setMode(terminal, null);
  }
  requestChat(terminal, true);
}

export function toCli(terminal) {
  const m = modes()[terminal];
  if (!m) return false;
  if (m.chat) {
    setMode(terminal, null);
    run("pane.close", { pane: m.chat });
    run("pane.focus", { pane: m.pane });
    return true;
  }
  if (!tabOf(m.cliTab)) return false;
  setMode(terminal, { ...m, cli: true });
  run("tab.unsettle", { id: m.cliTab });
  run("tab.select", { id: m.cliTab });
  run("pane.focus", { terminal });
  return true;
}

// Shows an agent: its chat in chat mode, else its terminal.
export function focusAgent(terminal) {
  const m = modes()[terminal];
  if (m?.chatTab && !m.cli && alive(m.chatPane)) return showChat(terminal, m);
  run("agent.focus", { terminal });
}

// Closes the chat view of a terminal that has ended, and its CLI tab. A chat tab without terminals
// (previews opened beside the chat) closes whole, unless it's its space's last tab.
export function closeWith(terminal) {
  const m = modes()[terminal];
  if (!m) return false;
  setMode(terminal, null);
  const space = spaces().find((s) => s.tabs.some((tb) => tb.id === m.chatTab));
  const others = space?.tabs.filter((tb) => tb.id !== m.chatTab && tb.id !== m.cliTab).length ?? 0;
  if (m.chatTab && others && !panes().some((q) => q.tab === m.chatTab && q.terminal)) run("tab.close", { id: m.chatTab, confirmed: true });
  else if (alive(chatPaneOf(m))) run("pane.close", { pane: chatPaneOf(m) });
  if (m.cliTab && tabOf(m.cliTab)) run("tab.close", { id: m.cliTab, confirmed: true });
  return true;
}

// Polls `get` every 50ms (up to `tries`), then calls next(value, cx); else gives up with fail(cx).
function poll(cx, get, next, fail, tries = 40) {
  const v = get();
  if (v) return next(v, cx);
  if (tries > 0) cx.timer.after(50, (c) => poll(c ?? cx, get, next, fail, tries - 1));
  else fail?.(cx);
}

// Moves a terminal into chat mode: the chat view splits in beside it, the terminal moves to a tab of
// its own (park, then keep as a tab) and that tab settles. Only the pond calls this.
export function convert(terminal, show, cx) {
  const p = panes().find((q) => q.terminal === terminal);
  if (!p || modes()[terminal]?.chatTab) return;
  setShared("pane-plus.pending", { ...(shared("pane-plus.pending") ?? {}), [terminal]: Date.now() });
  const from = focused()?.tab;
  const done = (chat, cli) => {
    const home = tabOf(p.tab);
    const kept = tabOf(cli.tab);
    const name = home?.named ? home.name : kept?.named ? kept.name : null;
    if (name && kept?.name !== name) run("tab.rename", { id: cli.tab, name });
    if (name && !home?.named) run("tab.rename", { id: p.tab, name });
    if (show || from === p.tab) {
      run("tab.select", { id: p.tab });
      run("pane.focus", { pane: chat.pane });
    } else if (from && tabOf(from)) run("tab.select", { id: from });
    run("tab.settle", { id: cli.tab });
    setMode(terminal, { chatTab: p.tab, chatPane: chat.pane, cliTab: cli.tab, cli: false });
  };
  const before = new Set(panes().map((q) => q.pane));
  run("pane.split", { pane: p.pane, direction: "right", mod: "chat", props: { terminal } });
  poll(cx, () => panes().find((q) => q.mod === "chat" && q.tab === p.tab && !before.has(q.pane)), (chat, cx) => {
    run("terminal.park", { terminal });
    poll(cx, () => !panes().some((q) => q.terminal === terminal), (_v, cx) => {
      run("terminal.keep", { terminal, place: "tab" });
      // A keep that didn't take leaves the terminal without a pane, and out of agents(): ask again.
      const kept = () => panes().find((q) => q.terminal === terminal);
      poll(cx, kept, (cli, cx) => done(chat, cli), (cx) => {
        run("terminal.keep", { terminal, place: "tab" });
        poll(cx, kept, (cli) => done(chat, cli), null, 60);
      });
    });
  });
}
