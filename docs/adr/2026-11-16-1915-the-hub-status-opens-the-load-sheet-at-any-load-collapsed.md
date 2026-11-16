# The Hub status opens the load sheet at any load, collapsed, and a builder's detached load is caught

Status: accepted (owner, 11/16, card T-564)

Six `yes` processes a builder started at 02:51 to load the CPU while it reproduced a flake ran for seven hours after it finished, about six cores. The load sheet (2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md) listed them under Other, and only opened while the host read busy. The owner asked: "What is yes. Also this panel should open tapping status even when not busy, and should open fully collapsed", and whether the builder would stop it itself.

Now:
- The Hub row's status words open "What's loading the host" whatever they say: healthy, busy, paused or down. The rest of the row still opens the hub page.
- The sheet opens with every group shut, the orphans too. A re-read after a Stop keeps open the groups that were.
- The orphan group is titled "Looks orphaned". Besides a node process over a day old, it holds any process of the owner's left to launchd (parent pid 1), with no terminal, that has used 50% CPU or more and is over an hour old, whatever its program. An app's (inside a `.app`) or the system's (`/System`, `/Library`, `/usr/libexec`, `/usr/sbin`) programs never count by CPU alone, since they run under launchd with no terminal by design. Each one gets Stop, as any orphan does.
- `ps` reads the terminal (`tty`) column for this; `??` or `?` is none.
- A builder's brief says that a process it starts in the background is stopped before the command that started it returns, with a `trap` or a `kill`.
- `builder done`, on any record that keeps a worktree, refuses while a process of the owner's runs detached (parent pid 1) that started since the build began and works in the worktree (its working directory, read with `lsof`, or a path on its command line, inside it). The refusal names each process and the `kill` that stops it. git's own detached gc and maintenance don't count. When `ps` gives no answer in time, the check passes, so a busy host never holds a finish.
- The orchestrator's skill says that any action it is denied (a kill, `tailscale serve`, `gh issue close`, an install) goes to the owner as a script on the task (2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md), never as a command typed in prose.

Not here: the refusal reads detached processes only. One still parented to the builder's session ends with it. Linux hosts where a subreaper, not pid 1, adopts orphans aren't caught.
