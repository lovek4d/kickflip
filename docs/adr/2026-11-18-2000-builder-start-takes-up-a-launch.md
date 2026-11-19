# A build's builder start takes up a launch, and a stuck In Progress card restarts in place

T-753 went In Progress when its script card ran, with nothing building it. The orchestrator ran `builder start --kind build` on it, which wrote an open build record and launched nothing: the board launches builders only from the pull, a tap or its own relaunches. The card then read as building, no relaunch took it (it was in no tracked launch), `builder resume` refused it for want of a session, and only the stale wait brought it back.

`builder start` is the check-in of an agent the board launched: every headless brief tells its agent to run it first, and `builder done` closes the record it opens. So on a board, a build's start on the card's main record now refuses unless there is a launch to take up:

- a record the pull, a Build tap or a session's `--dispatch` opened and nobody took up yet (`dispatched`);
- a launch the board made: its launch claim (`data/launches`, 2026-11-18-2030) is held, or the session it recorded is newer than the record's last start or close (a fresh lander on a closed record);
- a handed-back build with calls not yet verified, which the start resumes;
- `--dispatch` itself, which a session runs right before it launches its own builder.

With none, it refuses saying the pull launches a ready task's builder and the board restarts a stuck one. A start off a board (no `--site`, or `--dir`), under another agent name, or of a kind that isn't a build (a planner, a visual agent, a reviewer, a helper, an install) is not a build's check-in and is left as it was: those either always run beside a launch the board records or are no card's build.

The other half is mechanical. Each minute, and at boot with no grace, the board takes every open card In Progress that is not held, not blocked by a task and owes a Next (domain.mjs `owesNext`: no open agent record, no Next, no hand-back, no PR or push), and launches its builder in place: a fresh build record dispatched `hub`, in the worktree its last build kept (startBuilder's `ownWorktree`, made only when none is left), the card staying In Progress on its slot, with a "Restarted its builder in place" thread line and a `restart` audit entry. A card that entered the lane, or whose last run closed, within two minutes is left for that start or finish to complete. A launch the usage gate holds waits as any pull's does; a restart that fails is logged, and the card's `unowned` wait, now naming the restart and `audit <key>`, stays with the orchestrator.

This replaces `launchLostBuilds` (2026-11-15-1630), whose cards In Progress with no agent record at all are a case of the same check.

Chosen over sending the card back to ready for the pull (the owner: "shouldn't it restart in place?"): the card keeps its slot and worktree, and no lane move reads as the work going backwards. Chosen over making `builder start` itself launch the board's builder: then the agent's check-in and the orchestrator's launch would be one command, and an agent's own start could launch a second builder beside itself.
