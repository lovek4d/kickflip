# The hub's Codex share is the only Codex setting

The owner settled on hub/INT-229 that the hub's Codex share is the one setting that decides how sessions use Codex: "just want the top level hub setting to be the only one that defines codex share". No session or board overrides it; the codex-share hook tells each session to run as the hub setting, without deferring to a per-session mode file, and the Usage card drops the "Applies to every board…" note.

The choices' descriptions are:

- Always on: "Codex builds and reviews. Work pauses when it runs out."
- Auto: "Codex builds and reviews, and Opus takes over while it's out."
- Off: "Opus builds and reviews."

Supersedes [one Codex setting for every board](2026-10-30-1856-one-codex-setting-for-every-board.md) in part (its last line about a session's own `/codex-share`) and [Codex share sits in the Usage card](2026-11-01-1428-codex-share-sits-in-the-usage-card.md) in part (the note under the control).
