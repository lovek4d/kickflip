# A land failing on main's own test blocks on main's fix

Card #963 (hub/T-620). On 11/17 all four In Progress slots were held by verified cards (#948, #949, #950, #951) whose
lands failed on `board/temp-dirs.test.mjs`, broken on main by `hub/shell.test.mjs`. The fix for main, #955, sat ready in
Todo behind them: a deadlock. The owner's answer (t620-fix): "Block it on main's fix, freeing the slot".

## Why the base-fail pass missed

[A land reruns an untouched failing test on main](2026-11-14-1530-a-land-reruns-an-untouched-failing-test-on-main.md)
let a land pass only when no failing file was one the change reaches (`affectedTests` `touched`). `temp-dirs.test.mjs`
names `board/worktree.mjs` and `board/board-fixture.mjs` as plain strings, so the selector has it reaching 176 files,
`board/public/style.css` and `board/store.mjs` among them: every one of those cards touched it, and the rerun on main
never ran. The test does depend on every test source, which it reads, so narrowing its reach would only hide that.

## Decision

- **A failing land reruns its failing files on base** (`worktree.mjs` `failingOnBase`), touched or not. When every one
  fails there too, and each is untouched or fails there with the same failures, the land passes with a `Found:` call,
  as before. A failure's key (`nodeTests` `signatures`, per file) is its test's name and TAP diagnostic without the
  location, duration and stack, the checkout's folder read as `.`, so a change that shifts lines or runs in another
  worktree keys the same, and one that adds a case to the same assertion does not.
- **Failing on base but differently, the land waits on main's fix** (`finish.mjs` `landCard`, `store.mjs`
  `waitOnMainFix`). It blocks the card on an open card whose title names one of the failing files, by path or by name
  less `.mjs` (`temp-dirs.test`), else on an ask it files for the fix (`item add --ask`'s path), related to the card and
  blocking it, with the full test output's path. The thread says so (hub line `land-held-on-base`). Blocked, the card
  takes no slot ([a blocked In Progress card takes no slot](2026-11-16-0300-a-blocked-in-progress-card-takes-no-slot.md)),
  and the fix is pulled first.
- **The verification stays through the block.** The build is handed back and its verification restamped, so after the
  block the lander's launch is a first (`domain.mjs` `landStep`), and the lander lands it once the fix is done. A
  verified build waiting to land owes no `unblocked` wait: its land step is its wait
  ([an unblock past Todo waits on the orchestrator](2026-11-07-1500-an-unblock-past-todo-waits-on-the-orchestrator.md)).
- A failing file that passes on base is still the change's: the land refuses as before.

## Consequences

- A land whose own tests fail now pays for a rerun of the failing files on base before it refuses.
- Only the title is searched for an open fix, so a card that only mentions the test in its notes isn't taken for one.
