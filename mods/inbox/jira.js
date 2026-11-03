// Jira calls shared by the inbox and the Jira preview: REST reads as the CLI's user, and writes that
// setup.json's jira.dry_run turns into lines in inspect/jira-dry-run.log.

import { exec, notify, appHome } from "herdr";
import * as fs from "fs/promises";

// A REST GET as the CLI's user (`jira me`): $JIRA_API_TOKEN, else ~/.netrc.
export async function jiraGet(cfg, path) {
  const me = await exec(cfg.cli ?? "jira", ["me"]);
  if (me.code !== 0) return me;
  return exec("/bin/sh", ["-c", 'if [ -n "$JIRA_API_TOKEN" ]; then curl -sf -u "$1:$JIRA_API_TOKEN" "$2"; else curl -sf --netrc "$2"; fi',
    "sh", me.stdout.trim(), `${cfg.site}${path}`]);
}

const quote = (a) => (/^[\w./:-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

// Runs a jira command that changes a ticket, or with dry_run logs it instead.
export async function jiraWrite(cfg, args) {
  const cli = cfg.cli ?? "jira";
  if (!cfg.dry_run) return exec(cli, args);
  const line = [cli, ...args].map(quote).join(" ");
  const file = `${appHome()}/inspect/jira-dry-run.log`;
  await fs.mkdir(`${appHome()}/inspect`, { recursive: true });
  const before = await fs.readFile(file, "utf8").catch(() => "");
  await fs.writeFile(file, `${before}${new Date().toISOString()} ${line}\n`);
  notify({ title: "Dry run: jira not called", body: line, level: "info", timeout: 5000 });
  return { code: 0, stdout: "", stderr: "", dry: line };
}

// Starting a ticket moves it to jira.start_moves_to unless it's there already: the transition into
// that status, else the name as given. Null when there's nothing to do.
export async function moveOnStart(cfg, key, from) {
  const to = cfg.start_moves_to;
  if (!to || from?.toLowerCase() === to.toLowerCase()) return null;
  const r = await jiraGet(cfg, `/rest/api/3/issue/${key}/transitions`);
  let name = to;
  try {
    const want = to.toLowerCase();
    const hit = JSON.parse(r.stdout).transitions.find((x) => x.to?.name?.toLowerCase() === want || x.name?.toLowerCase() === want);
    if (hit) name = hit.name;
  } catch { /* no transition list: try the name */ }
  const w = await jiraWrite(cfg, ["issue", "move", key, name]);
  if (w.code !== 0) notify({ title: `Couldn't move ${key} to ${to}`, body: w.stderr.trim() || w.stdout.trim(), level: "error", timeout: 5000 });
  else if (!cfg.dry_run) notify({ title: `Moved to ${to}`, body: key, level: "info", timeout: 3000 });
  return w;
}
