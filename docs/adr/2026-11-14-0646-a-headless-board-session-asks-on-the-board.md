# A headless board session asks on the board, not in a terminal prompt

A board's session running as a background job has nobody at its terminal. `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` each exist to wait for that person, so a call to one leaves the board unlistened: on the Sync Improvements board an orchestrator stopped this way three times running, each on `AskUserQuestion` (#674).

- **A PreToolUse hook refuses them at once** (owner, `t331-phone` on hub/T-331: refuse at once, ask on the board). `hooks-plugin/hooks/ask-gate.mjs`, registered in the plugin's `hooks.json` with matcher `AskUserQuestion|EnterPlanMode|ExitPlanMode`, denies with "This board session is headless, so nobody can answer a terminal prompt. Ask on the board: `question add --file`, or `reply <card> --questions`." The session reads the reason and carries on.
- **Headless board session** means both: `CLAUDE_JOB_DIR` is set, as it is in a background job, and the hook's `session_id` is some manifest site's `owner.session`. An interactive session keeps its dialog and plan mode, and a background job that owns no board passes too.
- **Permission prompts still come to the phone.** The ticket asked whether a background job's permission prompt waits, ends the job or auto-denies. [A background session's prompts and questions come to the phone](2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md) already answers it for the sessions the hub starts and resumes: `hub/permission-hook.mjs` waits up to 10 minutes for the owner's tap and then denies with a note, and the job keeps running. So there is no `PermissionRequest` gate.
- **`hub/permission-hook.mjs` keeps its `AskUserQuestion` branch** for headless sessions that own no board. A board session's call never reaches it, since PreToolUse denies before a permission dialog would show.

Supersedes in part [a background session's prompts and questions come to the phone](2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md): a board session's `AskUserQuestion` no longer waits on the phone.

Considered:
- keeping `AskUserQuestion` on the phone for hub-started board sessions, which still blocks the session while the hook polls, and leaves a job the hub didn't start with no hook at all;
- gating permission prompts in `PermissionRequest` too, which the phone already answers without ending the job.

Out of scope: Bash commands that read stdin (an interactive CLI, a git credential prompt), which a hook can't tell from ordinary commands.
