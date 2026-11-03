#!/bin/sh
# Pond demo for recording: pretend Claude agents (with sub-agent babies and live chat views) and a
# Codex diver, in the space you're looking at. Usage: pond-demo.sh start | stop
here=$(cd "$(dirname "$0")" && pwd)
hc() { env -i HOME="$HOME" PATH="$PATH" "$HOME/.local/bin/hc" "$@"; }
case $1 in
  start)
    space=$(env -i HOME="$HOME" PATH="$PATH" "$HOME/.local/bin/herdr-app" status | sed -n 's/.*"space": *"\([^"]*\)".*/\1/p' | head -n1)
    for s in login review codex docs; do
      mkdir -p "$here/runs/$s"
      hc run --bg --keep --name "demo-$s" --cwd "$here/runs/$s" --label herdr.space="$space" --label demo=pond -- python3 "$here/agent.py" "$s" >/dev/null
      sleep 1
    done
    echo "Demo started: 4 agents. Runs about 75 seconds. Stop with: $0 stop" ;;
  stop)
    # hc ls doesn't list labels, so find the demo by its names.
    for s in login review codex docs; do hc kill "demo-$s" >/dev/null 2>&1; hc rm "demo-$s" >/dev/null 2>&1; done
    for s in login review codex docs; do rm -rf "$HOME/.claude/projects/$(printf '%s' "$here/runs/$s" | sed 's/[^A-Za-z0-9]/-/g')"; done
    rm -rf "$here/runs"
    echo "Demo stopped and cleaned up." ;;
  *) echo "Usage: $0 start | stop" ;;
esac
