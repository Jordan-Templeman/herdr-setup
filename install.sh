#!/bin/sh
# Sets up this Herdr config on a Mac that already has Herdr: your setup.json, the git hook, the
# shared modules, the ⌘⇧K chat shortcut, the Claude Code status hooks, and the pond layout.
# Safe to run again. Run from ~/.config/herdr-app (see README.md).
set -e
cd "$(dirname "$0")"
here=$(pwd)
app="$HOME/.local/bin/herdr-app"

missing=""
for cmd in gh python3 claude; do command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"; done
[ -x "$app" ] || missing="$missing herdr-app (install Herdr: https://herdr.dev)"
[ -z "$missing" ] || { echo "Missing:$missing"; exit 1; }

if [ ! -f setup.json ]; then
  cp setup.example.json setup.json
  echo "Created setup.json from the example: edit it (repo, GitHub queries, Jira) before using the inbox."
fi

git config core.hooksPath bin/hooks
bin/sync-shared >/dev/null

# ⌘⇧K opens the chat view for the focused agent.
python3 - "$here/keys.json" <<'PY'
import json, os, sys
path = sys.argv[1]
keys = json.load(open(path)) if os.path.exists(path) else {}
if keys.get("global", {}).get("cmd-shift-k") != "mod.open:chat":
    keys.setdefault("global", {})["cmd-shift-k"] = "mod.open:chat"
    json.dump(keys, open(path, "w"), indent=2)
PY

# Claude Code reports its status, tools and sub-agents to Herdr through these hooks.
python3 - "$HOME/.claude/settings.json" <<'PY'
import json, os, shutil, sys
path = sys.argv[1]
hook = "~/.config/herdr-app/hooks/claude-status.sh"
wanted = [("SessionStart", None, "idle"), ("UserPromptSubmit", None, "working"), ("PreToolUse", None, "tool"),
          ("PostToolUse", None, "working"), ("Notification", "permission_prompt", "blocked permission"),
          ("Stop", None, "done"), ("SubagentStart", None, "sub-start"), ("SubagentStop", None, "sub-stop")]
settings = json.load(open(path)) if os.path.exists(path) else {}
added = 0
hooks = settings.setdefault("hooks", {})
for event, matcher, arg in wanted:
    command = f"{hook} {arg}"
    entries = hooks.setdefault(event, [])
    if any(c.get("command") == command for e in entries for c in e.get("hooks", [])): continue
    entry = {"hooks": [{"type": "command", "command": command, "timeout": 5}]}
    if matcher: entry["matcher"] = matcher
    entries.append(entry)
    added += 1
if added:
    if os.path.exists(path): shutil.copy(path, path + ".bak-herdr-install")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(settings, open(path, "w"), indent=2)
    print(f"Added {added} Herdr hooks to {path} (backup beside it).")
PY

env -i HOME="$HOME" PATH="$PATH" "$app" do layout.switch '{"name":"field"}' >/dev/null 2>&1 || true
echo "Done. Herdr is on the pond layout; Claude sessions started from now on report to it."
