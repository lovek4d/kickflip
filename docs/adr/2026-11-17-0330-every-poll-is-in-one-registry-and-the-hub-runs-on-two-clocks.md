# Every poll is in one registry, and the hub runs on two clocks

The owner (T-376): "I just want page running me through every single poll we do, sorted by frequency", then asked what each one was for, which could go and which could share a cadence, and settled on two clocks for the hub (11/16 19:08).

## Decision

**One registry.** `shared/polls.mjs` lists every job the hub, its board servers, the board pages and the hooks run again and again: `{id, group, name, what, every, runs, where}`, plus `clock` and `times` for a hub clock job, `cadence` words where `every` can't say it (one that follows the owner's presence, quiet hours' end), and `steps` for the Tick and the Board minute. Each timer names its entry with a `poll: <id>` comment on its line or the line above; a helper that is no poll itself, B.every's own setInterval and the hub's clock loop, says `poll: none`. `shared/polls.test.mjs` fails when a `setInterval` or `B.every` under `hub/` or `board/` has no such comment, or an entry's file doesn't name it exactly once. A timer that reschedules itself with `setTimeout` or `B.later` (the run log, the stream reopen, the restart waits) is tagged by hand; the test can't find one that isn't.

**The Polls page.** `/_hub/polls` (`hub/polls-page.mjs`) is drawn from the registry alone: read-only, outside the app shell, linked last among the hub settings rows. Groups by what each poll watches (GitHub and PRs, Slack, Sessions and prompts, Board upkeep, Hub upkeep, Updates, Pages, then Back-offs, not polls, greyed), each folding, with a count and a line of why; inside, fastest first. A row shows its name, what it does, where it runs (Hub, Each board, Each open page, Hook), the file:line of its `poll:` comment, read from the file on each load so it never drifts, and its cadence. Tick and Board minute open into their steps. No last run, no toggles: whether any poll becomes a setting is left open.

**Two clocks.** The hub runs a 1 s clock and a 15 s clock, one `setInterval` each, and each hub job runs every `times` ticks of its clock as its entry says; the hub refuses to start when an entry names a clock job it doesn't run.

| Job | Clock | Every |
|---|---|---|
| Reconcile (start, stop and restart board servers; end a shared page whose share went) | 1 s | 2 ticks, 2 s |
| Tick | 15 s | 1 tick |
| Hung boards | 15 s | 1 tick |
| New hub code | 15 s | 1 tick |
| Shared last seen | 15 s | 4 ticks, 1 min |
| Nightly suite check | 15 s | 60 ticks, 15 min, the npm check's cadence |

## Changes that came with it

- **Reconcile split.** The hung-board check and the hub's own new-code check left the reconcile pass for the 15 s clock; the hung check runs in turn with reconciles, reading each server as the last one probed it. A board server whose own code changed still restarts from the reconcile.
- **End unshared folded into reconcile.** Its own 2 s timer went; each reconcile ends it, and the owner's share POST still does at once.
- **Shared last seen became a flush.** A shared person's visit moves their time in memory; the 15 s clock writes it every minute when one moved, and the hub writes it as it closes. It was a write throttle on each visit.
- **The board server's stream ping went.** Only the hub holds a board's stream, over localhost, and hears a dead board by its socket closing. The hub's own 25 s ping to the pages stays, so Tailscale Serve doesn't idle a page's stream out.
- **The board check while the stream is down runs every 15 s**, with the questions page's, not 30 s.
- **The review digest opens at quiet hours' end**, the morning wake's time, on weekdays: the Mac's quiet hours' end today, read in the Slack timezone, where it was 09:00 there.

## Considered

- **Reconcile every 1 s.** It probes every site's port each pass; 1 s doubles that for a crash noticed a second sooner. It stays at 2 s, as 2 ticks of the 1 s clock.
- **The hub stream's timers on the clocks.** The 2 s upstream reconnect, 15 s sidebar refresh and 25 s ping run only while a page holds `/_hub/stream`, started and stopped with it; they stay `hub/stream.mjs`'s own and are listed on the page.
- **Session prompts.** The 25 s is how long one held request waits, not a timer; it is listed so the page has every recurring thing.

Extends [the browser's polls ride the change stream](2026-11-15-1921-the-browsers-polls-ride-the-change-stream.md), whose board check ran every 30 s, and [the npm check rides the hub's tick every 15 wall-clock minutes](2026-11-12-0110-the-npm-check-rides-the-hubs-tick-every-15-wall-clock-minutes.md). Supersedes the 09:00 of [one digest opens each day thread](2026-11-14-0449-one-digest-opens-each-day-thread.md).

Amended by [Slack is read every 30 seconds, on its own poll](2026-11-25-0200-slack-is-read-every-30-seconds-on-its-own-poll.md): the 15 s clock runs the Slack poll every 2 ticks.
