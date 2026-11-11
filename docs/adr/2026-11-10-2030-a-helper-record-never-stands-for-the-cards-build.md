# A helper's record never stands for the card's build

The board read a card's build as its newest build record by `started`. A helper that started after the main build (T-3's page-tests helper) became that record. The card never read `checking`, so no orchestrator-waits event fired. `builder verified` found a worktree that was already gone and printed only "judgment calls verified". `land` refused with "No worktree at" the helper's path.

Every read of the card's build skips helper records (`kind: helper`): `domain.mjs newestBuild` (so `handedBackAt`), and in `store.mjs` `recordedWorktree`, `recordedSession`, `builderModel`, the `landable` pick and `statusToFacts`. Landers, resumes and rebase runs record onto the main record, and a writing helper merges into the main worktree, so the main record holds all of it.

`builder verified` names why it did not land (not handed back, a record still holds unverified calls, a record is still open, or the worktree is gone) instead of printing only "judgment calls verified".

An exit-without-done watch was not added: a server-launched builder that exits with its record open is already relaunched once, then handed back (2026-11-04-1010).
