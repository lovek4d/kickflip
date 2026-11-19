# The hub gives every board session the watcher Stop hook

A board's watcher, `bin/wait-events.mjs`, exits on each wake; its exit is what re-invokes the orchestrator's session,
which must relaunch it. The Stop hook `hooks-plugin/hooks/watcher-stop.mjs` blocks a turn's end while the session's
board has no live watcher, naming the relaunch command. On 2026-11-19 a turn ended with no watcher and the board read
not listening: the hook never ran, since only `~/.claude/settings.json` carried it (added by init or `doctor --fix`),
that host's file lacked it, and the hooks plugin can't register a Stop hook.

The hub now adds the hook to `BG_SETTINGS` (`hub/sessions.mjs`), the `--settings` every session it starts or resumes
takes, the hub board's tmux session included. The guard no longer depends on the host's settings.json. Init still adds
the hook there and doctor still checks it, for a board session the hub didn't start. A session with both runs the hook
twice; each blocks at most once a turn (`stop_hook_active`), so the reasons repeat and nothing loops.

The watcher keeps exiting on each wake. Rejected:

- A never-exiting watcher streamed through Claude Code's Monitor tool: a monitor ends after 10 minutes at most, so the
  session would re-arm it more often than it relaunches the watcher today.
- A watcher that starts its successor before it exits: the successor is a detached copy whose exit wakes nobody, and a
  detached copy has swallowed events before.
