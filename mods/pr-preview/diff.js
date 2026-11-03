// Unified diffs as data: split by file with line numbers, and paired into side-by-side rows; and line
// comments as a message to an agent.

import { langFor } from "./highlight.js";

// A unified diff split by file, each line numbered on the side it belongs to.
export function parseDiff(text) {
  const files = [];
  let file = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    const start = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (start) {
      file = { name: start[2], adds: 0, dels: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (!file || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      file.adds++;
      file.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith("-")) {
      file.dels++;
      file.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(" ")) {
      file.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

// Lines for side-by-side view: context on both sides, each run of deletions paired with
// the additions that follow it, hunk headers across the whole row.
export function splitRows(lines) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.kind === "add") adds.push(l);
    else {
      flush();
      rows.push(l.kind === "hunk" ? { hunk: l } : { left: l, right: l });
    }
  }
  flush();
  return rows;
}

// A line and up to `around` lines either side of it in its hunk, as that side of the file reads.
export function snippet(file, side, line, around = 2) {
  const on = (l) => (side === "LEFT" ? l.kind !== "add" && l.oldNo : l.kind !== "del" && l.newNo);
  const lines = file?.lines ?? [];
  const i = lines.findIndex((l) => l.kind !== "hunk" && on(l) === line);
  if (i < 0) return null;
  const hunk = [];
  for (let k = i - 1; k >= 0 && lines[k].kind !== "hunk"; k--) if (on(lines[k])) hunk.unshift(lines[k]);
  const before = hunk.slice(-around);
  const after = [];
  for (let k = i + 1; k < lines.length && lines[k].kind !== "hunk" && after.length < around; k++) if (on(lines[k])) after.push(lines[k]);
  return [...before, lines[i], ...after].map((l) => l.text).join("\n");
}

// One comment on a line, for an agent: where, the code there, and what to say about it. Without a url,
// the agent's own worktree.
export function lineNote(files, c) {
  const at = `\`${c.path}:${c.line}\` (${c.side === "LEFT" ? "old" : "new"})`;
  const code = snippet(files?.find((f) => f.name === c.path), c.side, c.line);
  return [at, code != null && `\`\`\`${langFor(c.path) ?? ""}\n${code}\n\`\`\``, c.body].filter(Boolean).join("\n");
}

export function agentMessage(url, files, comments) {
  if (comments.length === 1) return `On ${url}, ${lineNote(files, comments[0])}`;
  return [`On ${url}:`, ...comments.map((c, i) => `${i + 1}. ${lineNote(files, c)}`)].join("\n\n");
}
