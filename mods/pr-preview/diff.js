// Unified diffs as data: split by file with line numbers, and paired into side-by-side rows.

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
