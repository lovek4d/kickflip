# A running command keeps a build's line blue

Amends `2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md` and
`2026-11-05-0800-a-quiet-builder-line-only-turns-gray.md`.

Owner (#318): "build status lines go gray pretty often, especially in testing phase." A builder runs the suite as one
long Bash command (4 to 10 minutes in real transcripts, none longer than Bash's 10-minute cap) and its transcript
writes nothing until the command returns, so the line went gray while the builder was busy.

## Decision

- A run's transcript counts as moving now while its newest transcript file's last message is a tool call with no
  result after it. `transcriptMovedAt` reads the file's tail for this, so a builder's silence, quiet and an untracked
  run's Stalled all start counting only once the command returns.
- A quiet builder is one with a live process, no status line, no transcript movement and no command running for 5
  minutes. The 5 minutes (`BUILDER_QUIET_AFTER`) stay. A builder stuck between commands still goes gray after them.
- Codex builders have no transcript the board reads and keep going by their status lines alone.
