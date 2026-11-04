# Finishing a build is one step

Card #195. Owner, 11/04: "I would like land to be the same thing as build or done, if it makes sense."

Before this, a builder finished with two commands: `builder done` stopped its record, and `land` fast-forwarded the worktree onto the board's branch and closed the card. A build with judgment calls stopped between them: the session ran `builder verified`, then landed it.

Now finishing is one step, in `board/finish.mjs` (`finishCard`):

- `builder done <key> --text "<what you checked>"` on the main build's open record that keeps a worktree, with no unverified calls, finishes the card. `--text` is its closing line, as `land`'s is. With unverified calls, done still hands the card back as checking.
- `builder verified` on a handed-back build (checking, no builder open, every call verified, its worktree still there) finishes it in the same step, `--note` its closing line. While a question on the card is open it says so and the card waits. If the finish refuses, the stamp stays and the card stays checking, so the server's headless lander (`store.landable`) or the session finishes it.
- `land --site` runs the same finish. `land` without `--site`, or with `--dir`, is unchanged.

What finishing does depends on the board:

- A local board (the hub board included) lands as before: rebase, tests, fast-forward, restarts, worktree removed, card and ticket closed. When the board's "Push main after a land" switch is on (`permissions.mjs` `pushMain`), the CLI then pushes the branch to origin itself (gh195-done-finishes: "a mechanical push to GitHub if we have a push switch on"). The card has landed by then, so a failed push is reported on the card's thread and leaves the land standing.
- A GitHub board pushes the card's branch, opens a draft PR (`gh pr create --draft`) and records it as `item set --pr` does. The card waits in In Review with Action needed: "Review draft PR #n" (gh195-pr-boards). Before, `land` there would have fast-forwarded the shared clone's local branch.
- A plain git remote pushes the branch and records it as `item set --pushed` does.

A finish that fails refuses with the reason before it changes the card (gh195-fails). The builder's record stays open, so the builder fixes what the refusal names and runs done again.

Only the main agent's record finishes. A done from an `--agent` helper only stops that record, and the main build's done refuses while a helper's record is still open, since finishing closes every record. `--next` still stops a build without finishing it. Grills, prototypes and other records without a worktree stop as before.

The words stay as they were (gh195-words-look: C): the "landing" phase, the "Push main after a land" switch, "Orchestrator review" and "landed and done".

The headless builder's and lander's briefs now end with `builder done --text`.
