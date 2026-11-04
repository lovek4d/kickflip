# A board session never stalls on a Workflow prompt

Claude Code's Workflow tool runs a script that fans out subagents, and it asks for the owner's opt-in with a prompt at the terminal. A board session has nobody at its terminal: a background session has none, and the hub board's tmux session is usually unattached. On 11/04 the hub board's session launched a Workflow to grill eight cards and sat at that prompt until the owner answered it.

**Every session the hub starts or resumes denies Workflow.** `BG_SETTINGS` in `hub/sessions.mjs`, the inline settings each hub start and resume passes with `--settings`, the hub board's tmux session included, carries `permissions: { deny: ['Workflow'] }`. A denied tool is refused at once, with no prompt. A background session resumed in place keeps the settings it started with, so a running board gets the rule only from its next fresh start ([a board's session wakes when an event arrives](2026-10-30-1601-a-boards-session-wakes-when-an-event-arrives.md)).

**The skill says to fan out with Agent calls.** SKILL.md tells a board session to fan out with separate Agent calls, never Workflow. That covers a board session started by hand in a terminal, which gets no hub settings.

Considered:
- a deny rule that `kickflip init` and `doctor` write into the board folder's `.claude/settings.local.json` (the file [board settings' permissions switches](2026-11-03-1921-board-settings-grant-a-boards-session-permissions.md) write): Claude Code applies it to every session in that folder, so the owner's own terminal sessions in a board's repo, this repo among them, would lose Workflow too. Init also runs before any board exists and doesn't know the board folders.
- `--disallowedTools Workflow` on the session's command line: the same reach as the settings rule, but the flag takes a list, so it could swallow the prompt that follows it in the argv.
