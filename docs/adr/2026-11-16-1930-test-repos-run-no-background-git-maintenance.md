# Test repos run no background git maintenance

Land runs failed now and then on `ENOENT, No such file or directory '<home>/repo/.git/objects'`, under whichever test happened to call `scratchRepo` (board/board-fixture.mjs) first in its file. Every failure was the `fs.cpSync` of the per-file base repo, at the `.git/objects` level.

The cause: a `git commit` starts a detached `git maintenance run --auto`, which runs on after the commit returns and holds `.git/objects/maintenance.lock` for a moment (40 probe commits on this Mac's git 2.55 showed the lock 73 times in the 300 ms after each). Node's `cpSync` lists a directory, then copies each entry; a lock listed and gone before its copy fails the copy with ENOENT, and node names the directory being copied. The base repo's commit is followed at once by the first test's copy, so the copy can meet the lock.

## Decision

`makeBaseRepo` sets `maintenance.auto=false` in the base repo before its commit. The setting lives in `.git/config`, so every scratch repo copied from it, and every git command a test or the board's own code runs there, starts no maintenance either.

Proof: a stress script making a base repo, committing and copying it at once, 8 processes at a time, 50 repos each with 5 copies, failed 4 of 2,000 copies with the land's exact error before the setting and none of 2,000 with it. board/board-land.test.mjs checks that commits in a scratch repo leave nothing but object dirs in `.git/objects`.

## Considered

- **`gc.auto=0` as well.** Not set: git reaches `gc --auto` only through auto maintenance, which the one setting stops.
- **`GIT_CONFIG_*` in every test's environment.** Broader than the race: only the copied repo is copied while something may write it, and the repo's own config covers the git the board's code runs there too.
- **A copy that skips the lock, or retries.** Hides the background process instead of not starting it, and leaves it running past the test.
