# Landing is one choice: Draft PR, Ready PR or Merge

Card #263. The owner asked for "a new setting for whether we create PRs at all or go direct to main"; the setting existed already (#225's PRs switch), so the card prototyped how it should read. Round 2 note, verbatim: "maybe the three way can be draft pr / ready pr / merge. with that language stays main agnostic, whatever the base branch is. and then the auto merge stays as a separate switch". Round 4 answer: "yes but auto merge should be for prs or pending base branch merges both, update the subtitle".

Board settings now has a **Landing** section between Tickets and Auto, a three-way segmented choice:

- **Draft PR**: "Opens a draft; you mark it ready." Each card opens a draft PR and waits for the owner to mark it ready for review.
- **Ready PR**: "Opens ready for review once CI passes." The hub marks the draft ready once its CI passes ([a board can skip the draft](2026-11-04-1913-a-board-can-skip-the-draft.md)).
- **Merge**: "No PR; lands on the base branch." Each card lands on the base branch, which is pushed ([a land waits for your Merge](2026-11-04-2100-a-land-waits-for-your-merge.md)).

It replaces the PRs and Skip the draft switches in the Auto section, and the note under Skip the draft about Auto-merge. It shows where the PRs switch did, on a GitHub board that builds from its shared clone; Reviewers still show only while cards open PRs. The wording says "the base branch", never "main".

**Auto-merge** stays its own switch in the Auto section with one subtitle, whatever Landing is: "Claude merges a PR once it is approved, green and merges cleanly, and lands a build waiting to merge into the base branch."

**Storage is unchanged.** The choice is the two existing `board.json` keys read together: Draft PR is `prs` on and `skip_draft` off, Ready PR both on, Merge `prs` off. A tap saves its choice's keys in one `POST api/settings`, with no confirmation; Merge still needs Push main granted, and the server's refusal shows under the choice with the saved one still pressed. Finishing, the hub's GitHub check and `board.mjs settings set prs|skip-draft` read and write the same keys as before, so only Board settings changed.

Considered:
- one `landing` key in `board.json` in place of `prs` and `skip_draft`, which would move every reader (finish, the hub's check, the CLI, wake lines) for no change the owner can see;
- a PRs switch with Skip the draft beneath it (round 1's take A), which kept two switches for one decision;
- a two-way "Open PRs / Land on main" choice (round 1's take B), which said "main" and left Skip the draft a separate switch;
- an Auto-merge subtitle that changed with the Landing choice (round 3), which the owner turned down for one subtitle covering both.
