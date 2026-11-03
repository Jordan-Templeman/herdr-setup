// Opens an agent's worktree changes: the PR preview's diff, read from git, with line comments that
// go to the agent's session.
import { openOverlay } from "herdr";

export const openChanges = (terminal) =>
  openOverlay({ mod: "pr-preview", props: { terminal }, kind: "dialog", width: 0.85, height: 0.9 });
