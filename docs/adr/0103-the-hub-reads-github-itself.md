---
status: superseded in part by ADR-0104 and ADR-0107
---

# The hub reads GitHub itself

Superseded in part by [0104](0104-kickflip-owns-the-reviewer-record.md): kickflip also owns Slack reviewer steps; the optional monitor skill is not needed for reviewer links or digests.

Superseded in part by [0107](0107-the-hubs-poll-moves-the-owners-linear-tickets.md): the hub's poll moves the owner's Linear tickets; monitor's tick no longer needs to.

The hub's PR check is kickflip code, `hub/pr-report.mjs`, run with Node and gh. It needs neither zsh, jq nor the owner's monitor skill. A Linux host with Node and gh can poll the same PRs as a Mac.

The repo is the board's manifest `github`, else the wave's `repo`. The “me” login is the board's `github_login` setting, else `gh api user`, with no built-in defaults. Comments by that login carrying `<!-- claude-bridge -->` are Claude's own and are left out; its other comments are the owner's. Codex findings and human reviews remain in the report, and other bots are left out. The hub and `board.mjs pr` use the same report.

The session's GitHub tick steps live in SKILL.md: CI, draft conversation, review fixes, conflicts, the merge checks, thread lines and the handled-event cursor. The hub wakes the owning session on a PR change. The monitor skill is optional; when installed, its tick can add Linear status moves and the Slack bridge's steps.

A host without the owner's monitor skill or zsh could never see a PR change when polling called the skill's shell script. A built-in login also made Claude's own comments wake other owners' sessions. Kickflip owns both the poll and the steps it asks a session to run, and each board supplies its identity.

Considered:
- a POSIX sh script: still needs jq and keeps a second language;
- keeping the skill's script with a doctor check for zsh: still makes GitHub polling depend on an optional skill and another runtime.
