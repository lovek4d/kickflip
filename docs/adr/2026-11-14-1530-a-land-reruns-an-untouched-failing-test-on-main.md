# A land reruns an untouched failing test on main

Status: accepted (owner's answers t149-load-e and t149-flakes-e, 11/13)

## Decision

- A builder's brief says a timing taken while the host is busy is provisional, and its call says so
  ("Provisional: <timing>, taken while the host was busy"). Scheduling is unchanged.
- When a land's tests fail only in test files the change doesn't reach (`affectedTests` now also returns `touched`,
  the tests that reach a changed file, even when a broad change runs every file), `prepareLand` reruns those files on
  `base` in a worktree of its own (`failingOnBase`). If every one fails there too, the land goes on and records a
  `Found:` call on the card; a file that passes on `base`, or any failing file the change touches, refuses the land as
  before.

## Why

Per the T-321 split, builders run only their own tests and the land runs the affected set, so a test the change never
touched can fail at the land. That failure is flaky or already on main, not the card's, and sending the card back for it
costs a build for nothing.

## Consequences

- The `Found:` call is recorded after the card's calls were verified, so the orchestrator reads it on the closed card
  and files it; it doesn't hand the card back.
- A failing test file is named by the location the runner reports (`nodeTests` result `failedFiles`).
