// Answers bin/herdr-inspect: when it drops a request file in inspect/, writes what the mods see
// (panes, agents, terminals with their status records, the shared values mods keep) to
// inspect/state.json. Runs in the pond because Herdr only runs mods that are shown.
import { appHome, panes, agents, terminals, shared, focused, watchFolder, exec, readTextFile, writeTextFile } from "herdr";

const SHARED = ["pane-plus.chat", "pane-plus.pending", "pr-preview.pending", "layout"];

export function serveInspect(cx) {
  const dir = `${appHome()}/inspect`;
  cx.spawn(async () => {
    await exec("mkdir", ["-p", dir]);
    for (;;) {
      await watchFolder(dir);
      const r = await exec("rm", [`${dir}/request`]);
      if (r.code !== 0) continue;
      const state = {
        at: new Date().toISOString(),
        focused: focused(),
        panes: panes(),
        agents: agents(),
        terminals: terminals().map((t) => ({ address: t.address, name: t.name, state: t.state, status: t.status, cwd: t.cwd, parent: t.parent, labels: t.labels, records: t.records, title: t.title })),
        shared: Object.fromEntries(SHARED.map((k) => [k, shared(k) ?? null])),
      };
      // Replacing a file needs its current text.
      await writeTextFile(`${dir}/state.json`, JSON.stringify(state, null, 1), await readTextFile(`${dir}/state.json`));
    }
  });
}
