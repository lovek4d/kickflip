# Commits are Conventional and name their card in a Refs trailer

Status: accepted (#517, 11/11). Amended by [outside text cites only external refs, and a subject ends with its ticket](2026-11-24-2100-outside-text-cites-only-external-refs-and-a-subject-ends-with-its-ticket.md): a subject ends " (<ticket>)" when the card has a ticket, and the `Refs:` trailers name only tickets, the card's and its related cards', none for a card with no ticket. Amended by [a builder writes its PR's body by the repo's PR guide](2026-11-24-0300-a-builder-writes-its-prs-body-by-the-repos-pr-guide.md): the squash body is the PR body's Summary section, and a scope may be a comma list (`feat(api,web): …`). Land's check of every commit is superseded by [every land squashes the branch into one commit](2026-11-11-2318-every-land-squashes-the-branch-into-one-commit.md): land checks the squash message only and writes the Refs trailer itself.

## Context

Landed commits read "<ref>: <one sentence of what now holds>", with the ref a ticket (#N), a task (T-N) or a tracker id (INT-N). Over 730 commits the sentences grew: 490 subjects ran past 72 characters, cut off in `git log` and GitHub's list, and many chained several clauses. Releases read "Version X.Y.Z" with every change listed below. The owner asked for a standard from now on (11/10).

The owner's answers on #517:
- The form is Conventional Commits: "the ticket ref should be in the description, not the commit itself. go conventional".
- The types are the full Angular set. The scope is optional, lowercase and names the area, and land checks only its shape.
- The subject is at most 72 characters, and land refuses a longer one.
- The ref goes in a `Refs: <ref>` trailer on every commit, which land requires.
- On GitHub boards the builder writes the PR title as a Conventional subject from its diff, and the orchestrator may edit it at verify. `board.mjs merge` sets the squash commit's subject to the PR title and its body to the detail and the trailers, with no " (#N)".
- A release is `chore(release): X.Y.Z`, with the subjects landed since the last tag as its body.
- The orchestrator's hand commits follow a SKILL.md rule. There is no git hook, so land stays the only check.
- History is not rewritten, and there is no CHANGELOG backfill. The standard starts from now.

## Decision

**One module holds the standard.** `board/commit-message.mjs` holds the types, the 72-character cap, `subjectFault` (why a subject isn't Conventional within the cap), `standardWords` (the standard as one sentence, used by the briefs), `squashBody` and `releaseMessage`.

**Land checks every commit a card's branch adds** (`refuseBadMessages` in `board/worktree.mjs`). It refuses a subject `subjectFault` finds fault with, and a commit whose trailers (git's `%(trailers:key=Refs)`, read from the message's last paragraph) don't include `Refs: <ref>`, naming the commit and the fix. The "# Conflicts:" check runs first, because the note it catches sits below the trailers and would otherwise read as a missing Refs. A land with no card (`land` without `--site`) checks only that note, as before.

**The briefs give the standard.** The builder's and a writing helper's brief give `standardWords(ref)` in place of the old `"<ref>: <what the card now does>"`. `core.commentChar=';'` stays in the commit and rebase commands, so a message line that starts with "#", such as a ref wrapped to a line's start, survives git's cleanup.

**A new PR's title is a Conventional subject.** `builder done` and `builder verified` take `--title`. On a GitHub board with PRs on, a finish that opens a new PR titles it with `--title`, or else with the branch's first commit subject. It refuses a title `subjectFault` faults before anything is pushed or tested. A card whose PR is already open keeps its title. The builder brief asks for `--title` written from the whole diff. At verify the orchestrator passes its own.

**The squash merge is the PR's title over its body and trailers.** `board.mjs merge` and the Merge tap run `gh pr merge --squash --subject <PR title> --body <squashBody>`. The body is the PR body's Summary section, wrapped at 72 (the whole body when it has no Summary heading), then `Refs: <card ref>` and each Co-Authored-By trailer the PR's commits carry, once each, matched without regard to case. GitHub's " (#N)" suffix goes because `--subject` replaces its default. The merge reads them with one `gh pr view --json title,body,commits` per PR just before its `gh pr merge`. They stay out of `PR_VIEW_FIELDS`, whose view also feeds PR reports, where `commits` already means the GraphQL query's recent commits.

**Releases go through `scripts/release.mjs <x.y.z> --ref <ref>`.** It lists the subjects since the last `v*` tag, oldest first and skipping merges, and commits the version bump with `releaseMessage`, which ends in the card's `Refs:` trailer. Land makes and pushes the tag ([land tags a release commit and pushes the tag](2026-11-12-1251-land-tags-a-release-commit-and-pushes-the-tag.md)).

## Consequences

- A branch built before this lands holds "#N: ..." commits, which land now refuses. Its builder or lander rewords them to the standard, adding `Refs: <ref>`, then lands again.
- The first release after this lists the old-form subjects landed since v0.8.0 alongside the new ones.
- An external PR added to a card with `item set --pr` merges with its own title as the subject, unchecked. Since [a card's title is its PR title](2026-11-12-0800-a-cards-title-is-its-pr-title.md), merge checks it, and a new PR takes the card's title in place of the first commit subject.
