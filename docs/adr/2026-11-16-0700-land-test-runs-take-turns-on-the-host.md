# Land test runs take turns on the host

Status: accepted (owner's answer t502-cap, "One at a time", 11/15)

Amends [a merge tap waits its turn to land](2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md): only the
fast-forward held the land lock, so every verified card's land ran its affected tests at once.

## Decision

- **Land test runs take a slot on the host.** `holdingTestSlot` (worktree.mjs) runs a land's tests when fewer than
  `max_land_tests` runs are live: a file per run in `~/.claude/kickflip/landtest.running`, asks queued in
  `landtest.queue`. The queue order is the land queue's: bumped first (the latest bump ahead), then first asked.
  `moveQueuedLand` moves a bump's test ask with its land ask. A run whose process is gone is not counted.
- **The bound is around `runTests`, whatever it runs.** `landInTurn` wraps the runner in `boundedTests`, so a repo with
  another test command gets the same bound unchanged.
- **The setting is the hub's one number**, `landTests` in the hub's settings.json (push.mjs `readLandTests`), 1 by
  default, 1 to 99, not derived from cores. The slots are host-wide, so the number is too: a per-board number would let
  two boards disagree about one limit. Every land reads it from the hub's file. It is set in Hub settings' Usage card
  ([models and land tests are hub settings only](2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md)).
- **A land waiting for a slot says so.** A `test-waiting` status line, "Waiting to test: <card> is testing first",
  is the card's newest line until its test report starts; a held Merge reads it as merging.
- The fast-forward still takes the land lock alone.

## Why

Four lands tested at once: 31 `node --test` processes, load 45 on 10 cores. A land took ~12 minutes against ~1.5 alone,
and hub tests failed on timing under the load, sending cards back for another round that landed into the same pile.
The owner wanted lands parallel but bounded (T-211); one at a time is the Mac's answer, the setting the way to raise it.

## Not done

The machine-budget count against builders ("not start while the host is past its load line") is not built: builders and
lands share no budget here; the queue alone removes the pile. Hub tests that fail under load are not fixed here.
