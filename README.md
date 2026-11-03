# Herdr setup: pond, inbox, chat

A [Herdr](https://herdr.dev) config for running Claude Code (and Codex) agents from one window:

- **The pond**: every agent is a critter acting out what it's doing (reading, editing, running
  commands, waiting on you). Its sub-agents swim behind it as babies and leave when they finish.
  Hover for its task, branch and token use; click to focus; right-click for its chat.
- **Inbox**: your GitHub PRs and Jira tickets, with PR and ticket previews (diffs, inline review
  comments, submit a review). Start a review or ticket session from a row; a running session links back.
- **Chat**: any Claude agent as a chat instead of a terminal (CLI / Chat switch in the pane header,
  or ⌘⇧K): images, links, slash commands, and answering its prompts. New Claude agents open as a
  chat, their terminal in a tab put away until you switch to CLI (`"chat": { "default": false }` in
  `setup.json` turns that off).
- **Search** (⌘⇧O): agents, tabs, PRs, Jira tickets, files (names and contents) and every command in one
  fuzzy list; Enter opens it, ⌘Enter opens a file in RubyMine. Herdr's own palette stays on ⌘⇧P.

## Install

Needs macOS, Herdr, [Claude Code](https://claude.com/claude-code), `gh` (logged in) and `python3`.
Jira is optional (`jira` CLI from ankitpokhrel/jira-cli).

```sh
cd ~/.config/herdr-app
git init -b main
git remote add origin https://github.com/Jordan-Templeman/herdr-setup.git
git fetch origin && git checkout -f -t origin/main
./install.sh
```

Herdr owns most of `~/.config/herdr-app`; `.gitignore` tracks only this setup, so checking it out
there leaves Herdr's own files alone. `install.sh` creates `setup.json`, adds the ⌘⇧K and ⌘⇧O shortcuts,
adds the status hooks to `~/.claude/settings.json` (backup beside it), and switches to the pond
layout. Running it again changes nothing.

Then edit `setup.json` (untracked, yours): the repo sessions start in, the GitHub tabs and their
search queries, which rows get a start button and its prompt (`{url}`, `{key}`), Jira, and words the
pond drops from agent names. `setup.example.json` shows every key.

Only Claude sessions started after the hooks are in place report to the pond.

## Working on it

- `mods/<name>/`: one folder per mod (`field` is the pond, `pane-plus` the pane header).
  Herdr's mod guide is `AGENTS.md` here, with types in `herdr.d.ts`.
- `lib/`: modules several mods share. Edit them there, then `bin/sync-shared` (Herdr won't load a
  module from outside a mod's folder, so each mod gets a copy; the pre-commit hook checks they match
  and that every mod loads).
- `bin/herdr-inspect [panes|agents|terminals|shared]`: what the mods see right now, including
  terminal labels and status records (`hc ls` leaves those out). Needs the pond on screen.
- `demo/pond-demo.sh start|stop`: four pretend agents with sub-agents and live chats, for testing
  or a screen recording. `stop` removes them.
- `bin/check-upstream`: after a Herdr update, shows what changed in the originals `pane-plus` and the
  layout were copied from.
- Run `hc` and `herdr-app` from an agent's shell as `env -i HOME="$HOME" PATH="$PATH" ~/.local/bin/hc …`,
  or the agent's environment leaks into Herdr's terminals.
