// Opens an agent's worktree changes as a pane beside the focused one (the PR preview's diff, read
// from git, with line comments that go to the agent's session); a second open shows the same pane.
import { openBeside } from "./beside.js";

export const openChanges = (terminal) => openBeside("pr-preview", { terminal }, `changes:${terminal}`);
