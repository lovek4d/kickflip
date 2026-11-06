# A running command keeps a build's line blue

Amended by [stale is automatic, stalled is the orchestrator's flag](2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md): Stalled and `BUILDER_STALLED_AFTER` are now stale and `BUILDER_STALE_AFTER`.

Amends `2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md` and
`2026-11-05-0800-a-quiet-builder-line-only-turns-gray.md`.

Owner (#318): "build status lines go gray pretty often, especially in testing phase." A builder runs the suite as one
long Bash command (4 to 10 minutes in real transcripts, none longer than Bash's 10-minute cap) and its transcript
writes nothing until the command returns, so the line went gray while the builder was busy.

## Decision

- Whether a run's newest transcript file ends on a tool call with no result after it (a command still running) is its
  own reading, `transcriptCommandRunning`, taken from the file's tail. `transcriptMovedAt` keeps meaning the file's
  mtime, so an untracked run that died mid-command still reads Stalled after `BUILDER_STALLED_AFTER`.
- A quiet builder is one with a live process, no status line and no transcript movement for 5 minutes, and no command
  running. The 5 minutes (`BUILDER_QUIET_AFTER`) stay. A builder stuck between commands still goes gray after them.
- Codex builders have no transcript the board reads and keep going by their status lines alone.
