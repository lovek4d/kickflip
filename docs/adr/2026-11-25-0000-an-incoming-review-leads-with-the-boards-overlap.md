# An incoming review leads with the board's overlap

Asked to "take a look" at a teammate's PR, the board ran a full line-level review and posted seven findings. The repo
already had an automated reviewer, a GitHub Actions bot that had reviewed the same PR three times. Both found the one
blocking point; the board's other findings were the kind the bot exists for; and neither said how the PR touched the
board's own open and recent work, the one thing only the board knows (#1175). The session's only instruction for a
teammate's PR was "read its diff and review post it".

## Decision

**One command reads what the review needs, for both paths.** `board.mjs review overlap <pr>` (the PR's link,
owner/repo#n or a number in the board's repo) serves an auto review's `pr-review` and a review asked in Slack alike
(`board/review-overlap.mjs`). As the board's github-login it reads the PR's title, author, files (a rename's old path
too), CI, merge base with its base branch, and every review, comment and inline comment on it
(`hub/pr-report.mjs prForReview`), and prints:
- **Open tasks** whose worktree changes one of the PR's files: the worktree's diff from its merge base with the task's
  base, uncommitted and new files included. Worktrees, not card PRs (which `hub/incoming.mjs` matches on), so a
  Merge-mode board and a task with no PR yet count.
- **Tasks landed since the PR branched** that changed one: the commits on the board's base from the PR's merge base,
  each matched to a card by its landed commit, its subject's " (<ticket>)" suffix, or, for older commits, its `Refs:`
  trailer. A commit no card names isn't the board's work and is left out. A board on GitHub fetches its base once when
  its clone lacks the merge base.
- **Their notes' lines** naming a shared file by path or name: decisions the PR may contradict.
- "no overlap" when none of the above.
- **What was already said**, each review, comment and inline comment with its body, marking bots.
- **The read time**, for `review post --read-at`.
- **Whether a line-level review is due.** A bot's review or inline review comment on the PR means the repo has an
  automated reviewer, so it is not due; a bot's plain comment doesn't, since deploy and coverage bots (Vercel,
  Codecov, Netlify) comment on most PRs; with none yet and CI still running, it waits, since the bot usually posts from CI; else
  it is due.

**SKILL.md's Incoming reviews says how to write it**, and the `pr-review` line, its wait's Next and the Slack ask's
review step point there: overlap first, each task triaged (link it, note it, or drop it as unrelated) or "no overlap";
then what the board's work says to consider, only where no other review said it; line-level only when due or asked
for in words; no point another review made.

**`review post`'s read-time guard counts comments too.** A review, comment or inline comment written or edited after
`--read-at` refuses the post, so a bot's sticky comment updated in place since the read is caught.

## Considered

- Folding overlap into `review post`: the session needs it before writing, not at posting.
- Matching on card PRs' files as `hub/incoming.mjs` does: misses Merge-mode boards and tasks with no PR.
- Detecting "the repo has an automated reviewer" from its workflow files: a bot review or inline comment on the PR itself is
  direct and needs no repo read.

## Consequences

- A repo whose only bots are deploy or coverage bots still gets a line-level review. A review bot that posts
  only a plain comment, never a review or inline comment, isn't seen as one, so the board reviews line by line too.
- The owner plans to grill the incoming-review flow later; this records the direction.
