# Approval is per reviewer, and a bot never counts

The repo's Claude review runs as `github-actions[bot]` and submits APPROVED. That set the PR's `approved` flag, which the review digest read, so every PR dropped out of every human reviewer's digest and no digest went out from 11/13 (#899).

**Per reviewer.** A PR leaves reviewer R's digest, and R's digest header count, only when R's own latest review (matched on the reviewer's `github` login in the PR's `reviews`) is APPROVED, or when GitHub no longer needs an approval to merge it: its `reviewDecision` is APPROVED, or empty on a branch that asks for no review. Anyone else's approval, a bot's included, removes it from nobody else's digest (`waitsOn`, `board/store.mjs`).

**The reaction follows the same rule.** `review due` reacts `git_approved` on reviewer R's link and replies once R approved, or once the decision is APPROVED, or, where GitHub reports no decision, a person approved. A bot's or another person's approval reacts on nobody else's messages. This refines [git_approved waits for GitHub's decision](2026-11-12-1400-a-chip-per-pr-reviewer-and-git-approved-waits-for-githubs-decision.md), which reacted on every message at once, and its last line (the digest leaves out a PR anyone approved) no longer holds.

**Bots don't set `approved`.** The hub's check leaves a `Bot` author's APPROVED review out of the `approved` flag, the fallback for a branch with no decision (`hub/pr-report.mjs`).
