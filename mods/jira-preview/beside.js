// Opens a preview (pr-preview, jira-preview) as a pane beside the focused one, or shows the one
// already open for the same item instead of adding another. Shared "beside.panes": { item: pane }.
import { panes, run, shared, setShared, exec } from "herdr";

export async function openBeside(mod, props, item) {
  const known = (shared("beside.panes") ?? {})[item];
  const open = known && panes().find((p) => p.pane === known && p.mod === mod);
  if (open) {
    return run("pane.focus", { pane: open.pane });
  }
  const before = new Set(panes().map((p) => p.pane));
  run("pane.split", { direction: "right", mod, props });
  for (let i = 0; i < 40; i++) {
    const added = panes().find((p) => p.mod === mod && !before.has(p.pane));
    if (added) return setShared("beside.panes", { ...(shared("beside.panes") ?? {}), [item]: added.pane });
    await exec("sleep", ["0.05"]);
  }
}
