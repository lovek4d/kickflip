---
status: superseded in part by 2026-11-01-2347-kickflip-owns-the-reviewer-record, 2026-11-02-0023-the-hubs-poll-moves-the-owners-linear-tickets and 2026-11-02-2335-the-hubs-poll-records-merges-and-pr-comments-on-the-card
---

# The hub reads GitHub itself

Superseded in part by [kickflip owns the reviewer record](2026-11-01-2347-kickflip-owns-the-reviewer-record.md): kickflip also owns Slack reviewer steps; the optional monitor skill is not needed for reviewer links or digests.

Superseded in part by [the hub's poll moves the owner's Linear tickets](2026-11-02-0023-the-hubs-poll-moves-the-owners-linear-tickets.md): the hub's poll moves the owner's Linear tickets; monitor's tick no longer needs to.

Superseded in part by [the hub's poll records merges and PR comments on the card](2026-11-02-2335-the-hubs-poll-records-merges-and-pr-comments-on-the-card.md): the hub's poll writes owner and reviewer comments into the card's thread and records a merged PR; the session's tick no longer does.

The hub's PR check is kickflip code, `hub/pr-report.mjs`, run with Node and gh. It needs neither zsh, jq nor the owner's monitor skill. A Linux host with Node and gh can poll the same PRs as a Mac.

The repo is the board's manifest `github`, else the wave's `repo`. The “me” login is the board's `github_login` setting, else `gh api user`, with no built-in defaults. Comments by that login carrying `<!-- claude-bridge -->` are Claude's own and are left out; its other comments are the owner's. Codex findings and human reviews remain in the report, and other bots are left out. The hub and `board.mjs pr` use the same report.

The session's GitHub tick steps live in SKILL.md: CI, draft conversation, review fixes, conflicts, the merge checks, thread lines and the handled-event cursor. The hub wakes the owning session on a PR change. The monitor skill is optional; when installed, its tick can add Linear status moves and the Slack bridge's steps.

A host without the owner's monitor skill or zsh could never see a PR change when polling called the skill's shell script. A built-in login also made Claude's own comments wake other owners' sessions. Kickflip owns both the poll and the steps it asks a session to run, and each board supplies its identity.

Considered:
- a POSIX sh script: still needs jq and keeps a second language;
- keeping the skill's script with a doctor check for zsh: still makes GitHub polling depend on an optional skill and another runtime.
