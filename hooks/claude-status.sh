#!/bin/sh
# Claude Code hook: tells Herdr what this Claude is doing (OSC 7501).
# Usage: claude-status.sh <state> [kind]          the agent itself
#        claude-status.sh sub-start | sub-stop    a sub-agent, as its own record keyed by agent_id
#        claude-status.sh tool                    the tool it's about to use, in the record "tool"
# The "tool" record says what the agent is doing: a tool name, "think" between tools, "none" when it stops.
# A sub-agent gets the same as "<agent_id>.t", and its task (the Agent call's description) as "<agent_id>.d".
# No-op outside Herdr terminals.
[ -n "$HC_TERMINAL_ID" ] || exit 0
input=$(cat)
# Hooks have no terminal of their own: find the nearest ancestor that has one.
pid=$$
while [ "$pid" -gt 1 ]; do
  tty=$(ps -o tty= -p "$pid" | tr -d ' ')
  case $tty in ''|'??') pid=$(ps -o ppid= -p "$pid" | tr -d ' ') ;; *) break ;; esac
done
case $tty in ''|'??') exit 0 ;; esac

field() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1 | tr ':' '-' | tr -cd 'A-Za-z0-9_.-'; }
# Like field, for prose: spaces become dashes, cut to the 32 characters Herdr keeps.
words() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1 | tr ' :' '--' | tr -cd 'A-Za-z0-9_.-' | cut -c1-32; }
# Agent calls waiting for their sub-agent to start, as "<type> <description>" lines.
pending="${TMPDIR:-/tmp}/herdr-claude-subs-$(field session_id)"
sub=$(field agent_id)
# A sub-agent between tools is thinking; that's its baby's activity, not this agent's state.
[ "$1" = working ] && [ -n "$sub" ] && set -- sub-think
# A stopped turn starts no more sub-agents: drop calls that never started one (a denied call).
case $1 in done|idle) [ -z "$sub" ] && rm -f "$pending" ;; esac

case $1 in
  sub-start|sub-stop)
    id=$(field agent_id)
    [ -n "$id" ] || exit 0
    type=$(field agent_type)
    state=working
    [ "$1" = sub-stop ] && state=done
    printf '\033]7501;id=%s:state=%s:app=%s\007' "$id" "$state" "${type:-agent}" > "/dev/$tty" 2>/dev/null
    if [ "$1" = sub-stop ]; then
      printf '\033]7501;id=%s.t:state=done:app=none\007' "$id" > "/dev/$tty" 2>/dev/null
    elif [ -s "$pending" ]; then
      # The oldest waiting call for this type of sub-agent, else the oldest one.
      n=$(awk -v t="${type:-agent}" '$1 == t { print NR; exit }' "$pending")
      desc=$(sed -n "${n:-1}p" "$pending" | cut -d' ' -f2)
      sed "${n:-1}d" "$pending" > "$pending.$$" && mv "$pending.$$" "$pending"
      [ -n "$desc" ] && printf '\033]7501;id=%s.d:state=idle:app=%s\007' "$id" "$desc" > "/dev/$tty" 2>/dev/null
    fi
    ;;
  sub-think)
    printf '\033]7501;id=%s.t:state=working:app=think\007' "$sub" > "/dev/$tty" 2>/dev/null
    ;;
  tool)
    tool=$(field tool_name)
    # A sub-agent's tool calls belong to its baby, not to this agent.
    if [ -n "$sub" ]; then
      printf '\033]7501;id=%s.t:state=working:app=%s\007' "$sub" "$tool" > "/dev/$tty" 2>/dev/null
    else
      printf '\033]7501;id=tool:state=working:app=%s\007' "$tool" > "/dev/$tty" 2>/dev/null
      case $tool in Task|Agent) printf '%s %s\n' "$(field subagent_type | grep . || echo general-purpose)" "$(words description)" >> "$pending" ;; esac
    fi
    ;;
  *)
    extra=${2:+:kind=$2}
    case $1 in
      working) activity='\033]7501;id=tool:state=working:app=think\007' ;;
      done|idle) activity='\033]7501;id=tool:state=idle:app=none\007' ;;
      *) activity='' ;;
    esac
    printf "\\033]7501;state=%s%s:app=claude-code\\007$activity" "$1" "$extra" > "/dev/$tty" 2>/dev/null
    ;;
esac
# Which Claude session this terminal holds, so a chat view can find its transcript. Herdr drops
# values over 32 characters, so the id goes without its dashes.
session=$(field session_id | tr -d -- "-")
[ -n "$session" ] && printf '\033]7501;id=session:state=idle:app=%s\007' "$session" > "/dev/$tty" 2>/dev/null
exit 0
