// Where a GitHub PR link points: { url: the PR, anchor } where anchor is "discussion_r<id>" (a review
// comment), "issuecomment-<id>", "pullrequestreview-<id>", "files", or null. null for a non-PR link.
export function anchorFromUrl(link) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(\/[^#?]*)?(?:\?[^#]*)?(?:#(.*))?$/.exec(link ?? "");
  if (!m) return null;
  const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
  const hash = m[5] ?? "";
  if (/^(discussion_r\d+|issuecomment-\d+|pullrequestreview-\d+)$/.test(hash)) return { url, anchor: hash };
  return { url, anchor: /^\/files\b/.test(m[4] ?? "") ? "files" : null };
}

// Which view and target an anchor opens: { view, match(commentUrl) } for one comment, else just a view.
export function anchorTarget(anchor) {
  if (!anchor) return { view: "overview", match: null };
  if (anchor === "files") return { view: "files", match: null };
  const view = anchor.startsWith("discussion_r") ? "files" : "conversation";
  return { view, match: (u) => Boolean(u) && u.endsWith(`#${anchor}`) };
}
