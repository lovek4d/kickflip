# A land rebases when its test turn starts and keeps it through the fast-forward

Status: accepted (owner's question on #1061's repeated rounds, 11/18)

Amends [land test runs take turns on the host](2026-11-16-0700-land-test-runs-take-turns-on-the-host.md): the slot
was taken around `runTests` alone, after the rebase and released before the fast-forward.

## Decision

- **`landInTurn` takes the test slot for the whole turn**: the rebase onto base as it is when the turn starts, the
  tests, and the fast-forward under the land lock. The slot is released after the fast-forward.
- **With one slot each land tests once, in queue order**, since base moves only by lands and the orchestrator's own
  commits.
- **A land that finds base moved anyway** (a direct commit, or `landTests` above 1) rebases and tests again at once,
  in the slot it holds, not at the back of the queue.
- **A held land (Merge pending) gives the slot up once its tests pass.**
- `boundedTests` is gone: the bound is around the whole turn, not `runTests`.

## Why

A land rebased onto main, then waited for a slot, tested a base every land ahead of it was about to move, passed, found
main moved, and went to the back of the queue. #1061 tested 2516 tests on a stale base and started over; with N lands
queued the last one tested up to N times, each round waiting for the whole queue again.
