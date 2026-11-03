# One pretend agent for the pond demo: reports status, tools and sub-agents over OSC 7501 like the
# Claude hooks do, and (for Claude) writes a transcript so its chat view fills in live.
# Usage: python3 agent.py <scenario>
import json, os, sys, time, uuid

name = sys.argv[1]
# The ticket the demo links to: setup.json's "demo": {"ticket"} on its Jira site, so the link opens a real preview.
try: cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "setup.json")))
except Exception: cfg = {}
TICKET = ((cfg.get("jira") or {}).get("site") or "https://example.atlassian.net") + "/browse/" + (cfg.get("demo") or {}).get("ticket", "APP-123")
cwd = os.getcwd()
session = str(uuid.uuid4())
proj = os.path.expanduser("~/.claude/projects/" + "".join(c if c.isalnum() else "-" for c in cwd))
os.makedirs(proj, exist_ok=True)
log = os.path.join(proj, session + ".jsonl")

def osc(body):
    sys.stdout.write("\033]7501;" + body + "\007"); sys.stdout.flush()

def title(t):
    sys.stdout.write("\033]0;" + t + "\007"); sys.stdout.flush()

def write(rec):
    rec.setdefault("uuid", str(uuid.uuid4()))
    rec.setdefault("sessionId", session)
    with open(log, "a") as f: f.write(json.dumps(rec) + "\n")

APP = "codex" if name == "codex" else "claude-code"
def state(s, kind=None):
    osc("state=%s%s:app=%s" % (s, ":kind=" + kind if kind else "", APP))
    if APP == "claude-code": osc("id=session:state=idle:app=" + session.replace("-", ""))
def tool(t): osc("id=tool:state=working:app=" + t)
def say(text): write({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
def ask(text): write({"type": "user", "message": {"role": "user", "content": text}})
def use(name_, inp, secs, ok=True):
    tid = "toolu_" + uuid.uuid4().hex[:20]
    tool(name_)
    write({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tid, "name": name_, "input": inp}]}})
    time.sleep(secs)
    write({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok", "is_error": not ok}]}})
    tool("think")
def baby(aid, kind, task):
    osc("id=%s:state=working:app=%s" % (aid, kind)); osc("id=%s.d:state=idle:app=%s" % (aid, task[:32]))
def baby_tool(aid, t): osc("id=%s.t:state=working:app=%s" % (aid, t))
def baby_done(aid, kind):
    osc("id=%s:state=done:app=%s" % (aid, kind)); osc("id=%s.t:state=done:app=none" % aid)
def wait(s): time.sleep(s)

if name == "login":
    title("Fix login redirect loop")
    state("idle"); wait(3)
    ask("Users on SSO accounts get stuck in a redirect loop after login. Find it and fix it.")
    state("working"); tool("think"); wait(3)
    say("I'll find where the post-login redirect is decided, then reproduce the loop with a spec.")
    a1, a2 = "a1f3c9e2b7d4a6081", "a2b8e4d1c9f7a3052"
    use("Agent", {"description": "Find auth redirect handlers"}, 1)
    baby(a1, "Explore", "Find-auth-redirect-handlers"); baby_tool(a1, "Grep")
    use("Agent", {"description": "Write regression spec"}, 1)
    baby(a2, "general-purpose", "Write-regression-spec"); baby_tool(a2, "think")
    wait(5); baby_tool(a1, "Read"); baby_tool(a2, "Write"); wait(6)
    baby_tool(a1, "Grep"); wait(5); baby_done(a1, "Explore")
    say("Found it: `SessionsController#after_sign_in_path` sends SSO users back to `/login` when `return_to` is blank.")
    baby_tool(a2, "Bash"); use("Read", {"file_path": "app/controllers/sessions_controller.rb"}, 5)
    use("Edit", {"file_path": "app/controllers/sessions_controller.rb"}, 6)
    wait(4); baby_done(a2, "general-purpose")
    use("Bash", {"command": "bundle exec rspec spec/requests/sso_login_spec.rb"}, 9)
    say("Fixed. SSO users now land on their dashboard when there's no `return_to`, and the new spec covers the loop.\n\n- Spec: `spec/requests/sso_login_spec.rb` (3 examples, passing)\n- Ticket: " + TICKET)
    state("done")

elif name == "review":
    title("Review PR 1234 search analytics")
    state("idle"); wait(6)
    ask("Review https://github.com/acme/shop/pull/1234")
    state("working"); tool("think"); wait(3)
    say("Fanning out reviewers across correctness, tests and performance.")
    lanes = [("a3c7e1f9d2b4a8063", "general-purpose", "Correctness-lane"),
             ("a4d2f8e3c1b9a7044", "general-purpose", "Test-coverage-lane"),
             ("a5e9c3d7f1a2b6085", "codex", "Codex-second-opinion")]
    use("Agent", {"description": "Review lanes"}, 2)
    for aid, kind, task in lanes: baby(aid, kind, task); baby_tool(aid, "Read"); wait(1.5)
    wait(6); baby_tool(lanes[0][0], "Grep"); baby_tool(lanes[1][0], "Bash"); baby_tool(lanes[2][0], "think"); wait(8)
    baby_done(*lanes[1][:2]); wait(5)
    baby_tool(lanes[0][0], "think"); baby_tool(lanes[2][0], "Read"); wait(7)
    baby_done(*lanes[0][:2]); wait(4); baby_done(*lanes[2][:2])
    use("WebFetch", {"url": "https://github.com/acme/shop/pull/1234"}, 4)
    say("Two findings survived verification:\n\n1. `useSearchId` now takes an object, but `Templates.tsx` still passes a string.\n2. No spec covers the new `surface` key.\n\nWant me to post them as a pending review?")
    state("blocked", "permission")

elif name == "codex":
    title("Refactor search analytics hooks")
    state("working")
    for t in ["think", "Read", "Edit", "Bash", "think", "Read", "Edit", "Bash", "Edit"]:
        tool(t); wait(7)
    state("done")

elif name == "docs":
    title("Write PR description")
    state("idle"); wait(20)
    ask("Write the PR description for this branch.")
    state("working"); tool("think"); wait(4)
    use("Bash", {"command": "git log development..HEAD"}, 5)
    use("Read", {"file_path": ".github/pull_request_template.md"}, 4)
    say("Draft ready: two short paragraphs plus a test checklist. It's in `pr-body.md`.")
    state("done")

while True: time.sleep(3600)
