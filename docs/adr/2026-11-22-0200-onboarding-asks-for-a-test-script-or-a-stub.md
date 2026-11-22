# Onboarding asks for a test script or a stub beside the build script

Since [a land runs its repo's own test script](2026-11-21-2310-a-land-runs-its-repos-own-test-script.md), a repo with no node test files and no test script refuses to land. The scripts card wrote only build and release scripts, so a new board whose repo has no node tests would first meet that refusal at its first land.

The scripts card now has a Test script part between build and release. It states the contract and, when the chosen home has no test script and the repo has no node test files, has the agent ask the owner for the repo's test command, or whether to write a stub that exits 0 to opt out.

Considered: a `test` entry in `repoHas` and `kickflipHas`, to narrow the card to what main lacks. Left out: the scripts card is always present for its home question, and the part already says to act only when the home has no test script.
