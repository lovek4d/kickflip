# A builder writes its PR's body by the repo's PR guide

Status: accepted (#1176, 11/24). Amends [commits are Conventional and name their card in a Refs trailer](2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md) on the squash body and the scope.

## Context

On a GitHub board, `builder done --text` was the draft PR's body (`gh pr create --body`), while the builder brief kept `--text` "the short line of what you checked". So every board PR opened with a one-line body, and the orchestrator rewrote each with `gh pr edit`. `builder verified --note` did the same, within the thread line's 2,000 characters. A merge then squashed that body into main's commit.

The title check also refused a comma list of scopes, `feat(api,web): …`, which repos use for a change across two packages, so `merge` stopped and asked for a retitle.

The owner's answer (11/24): a merge's squash commit body is the PR body's Summary section only, wrapped at 72.

## Decision

**`--body-file` is the PR's body, apart from `--text`.** `builder done` and `builder verified` take `--body-file <path>`, markdown with no length cap. `--text` (and `--note`) stays the thread's closing line. The body is refused empty, with `--dir`, or on a helper's done.

**The board keeps the body until a PR takes it.** `keepPRBody` writes it beside the card's records as `agents/<id>.pr-body.md`. A done with judgment calls hands back before any PR opens, and `builder verified` opens it later with the kept body; verified's own `--body-file` replaces it. The body sits in a file rather than on the build's record because a failed verify launches a lander whose `builder start` replaces that record. `sendForReview` (`board/finish.mjs`) reads it:
- a new PR opens with the kept body, else with `--text` as before;
- on a card whose PR is already open (a reopened card, a red-CI fix run, a PR found by its branch), the push goes on and a kept body replaces the PR's with `gh pr edit --body`; with none kept, the body stays;
- once a PR takes the body, the file goes.

**The brief names the guide.** `builderBrief` (`board/headless.mjs`) resolves the guide once, from the worktree. It uses the doc AGENTS.md names on a line about PRs (a markdown link or a backticked `.md` path that exists), else `.github/PULL_REQUEST_TEMPLATE.md`, else kickflip's default. The default has four parts: Summary (Problem / Solution / Impact); Verification (the commands run, base then branch, in a collapsed block, and a "Not checked:" line); Known limits when there are any; and Merge risk (level, one-way or two-way door, blast radius, deploy order, rollback, what to watch). A red-CI fix run's brief says to leave `--body-file` out unless the open PR's body must change.

**Main's commit carries the Summary.** `squashBody` (`board/commit-message.mjs`) takes the PR body's Summary section: the lines under a `Summary` heading of any level, down to the next heading of that level or higher, with HTML comments dropped. A body with no such heading, as a hand-written PR's may lack, goes whole. It wraps lines over 72 characters between words, keeps a list item's later lines under its first word and leaves fenced code alone. Then come the `Refs:` and Co-Authored-By trailers as before.

**A scope may be a comma list.** `SHAPE` and the ask shape take `(<area>)` or `(<area>,<area>…)`, lowercase, with an optional space after each comma. `standardWords` and the refusals name the comma list. Triage's related-card match (`domain.mjs relatedCandidates`) counts a card sharing any one of the scopes.

## Consequences

- A board PR opens with the builder's full body, and the orchestrator's `gh pr edit` pass goes.
- Main's history gets the Summary paragraphs, not the Verification or Merge risk sections, which stay on the PR.
- A local or plain-remote board ignores a kept body: no PR takes it, and the file stays beside the records until a later GitHub finish or the card's next body overwrites it.
