// Agent sessions started from the inbox: one Claude terminal per item, tagged inbox.item=<key>
// (and inbox.url=<url>), so the item can link back to it.

import { hc, exec, run, spaces, panes, terminals, agents, notify, home } from "herdr";
import { setup } from "./setup.js";
import { focusAgent, modes } from "./mode.js";

// The live session for an item: one this file started, else an older tab named after the item.
export function sessionFor(key) {
  if (!key) return null;
  const tagged = terminals().find((t) => t.state === "live" && t.labels?.["inbox.item"] === key);
  if (tagged) return tagged.address;
  return agents().find((a) => a.tab_name === key)?.address ?? null;
}

// The live session whose item key appears in `text` (a PR's branch or title): a ticket's session that opened the PR.
export function sessionIn(text) {
  if (!text) return null;
  const mentions = (key) => new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i").test(text);
  const tagged = terminals().find((t) => t.state === "live" && t.labels?.["inbox.item"] && mentions(t.labels["inbox.item"]));
  return tagged?.address ?? null;
}

// The live session for a PR: its inbox item's, else a terminal labelled with its url.
export function sessionForPr(key, url) {
  return sessionFor(key) ?? terminals().find((t) => t.state === "live" && url && t.labels?.["inbox.url"] === url)?.address ?? null;
}

export function agentName(address) {
  const a = agents().find((x) => x.address === address);
  return a?.title || a?.tab_name || terminals().find((t) => t.address === address)?.name || address;
}

// Continues an agent's chat with `text`: null once sent, else why not.
export async function sendToAgent(address, text) {
  const r = await hc(["send", "--json", address, text]);
  if (r.code === 9) return "Answer the agent's prompt first.";
  return r.code === 0 ? null : r.stderr.trim() || "Couldn't send.";
}

export const statusOf = (address) => agents().find((a) => a.address === address)?.status ?? null;

export const openSession = (address) => focusAgent(address);

// Starts Claude on `prompt` in the space for setup.json's repo (else the shown one), in a tab named
// after the item, and shows it.
export async function startSession(key, prompt, url) {
  const { repo } = await setup();
  const space = spaces().find((s) => repo && s.folder === repo) ?? spaces().find((s) => s.active);
  const name = key.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  const args = ["run", "--bg", "--json", "--keep", "--name", name, "--cwd", space?.folder || repo || home(), "--label", `inbox.item=${key}`];
  if (url) args.push("--label", `inbox.url=${url}`);
  if (space) args.push("--label", `herdr.space=${space.id}`);
  // Through a login shell, like Herdr's own tabs, so mise's node and the rest of PATH are there for hooks.
  const r = await hc([...args, "--", "/bin/zsh", "-lic", 'claude "$1"', "claude", prompt]);
  if (r.code !== 0) {
    notify({ title: `Couldn't start a session for ${key}`, body: r.stderr.trim(), level: "error", timeout: 5000 });
    return null;
  }
  const { address } = JSON.parse(r.stdout);
  for (let i = 0; i < 20; i++) {
    const pane = panes().find((p) => p.terminal === address);
    if (pane) {
      run("tab.rename", { id: pane.tab, name: key });
      if (modes()[address]?.chatTab) run("tab.rename", { id: modes()[address].chatTab, name: key });
      break;
    }
    await exec("sleep", ["0.3"]);
  }
  openSession(address);
  return address;
}
