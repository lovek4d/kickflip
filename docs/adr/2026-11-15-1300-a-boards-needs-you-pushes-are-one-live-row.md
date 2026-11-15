# A board's needs-you pushes are one live row

Card #765 (T-190), from the owner on T-151: "make another ticket to revisit what push notifications come through, it has gotten noisy." The week of 11/08–11/14 sent 568 board pushes, 334 at once on weekdays (questions 157, Tap Implement 75, prototype pick 44), about 67 a weekday and 28 in the worst hour, each card under its own tag, so they stacked. The first grill settled on batching them through a 5-minute window; the owner then asked whether a board should have one notification, updated in place, "never multiple stacked for a single board unless there are faults, or the board is idle", and chose it (t190-live, t190-realert, t190-window2). This amends [the board records what it knows, and commands make the rule calls](2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md) and [pushes go out by kind, and each arrives on its own](2026-10-29-1639-pushes-go-by-kind-and-each-arrives-on-its-own.md) for action pushes.

## Decision

- **One notification per board.** Everything `ownerActions` lists (Action needed on a card, a Needs you topic, a held review) is one push tagged `board-<route>` (`board/domain.mjs` `ownerRow`). Several read "<board title> (N)", e.g. "Hub Orchestrator (3)", over what the owner's taps unblock, e.g. "2 builds wait on you · 1 question", and open Waiting on you (`questions.html`). One reads and opens as itself, as its card's push did.
- **Only the first push alerts.** The board server keeps the row it last pushed in `data/action-pushes.json` `{row}`. A row where there was none pushes and alerts; any change to its title, body or url pushes again at once with `silent`, which `hub/sw.js` shows under the tag with `silent: true` and no `renotify`. Once nothing waits the row is withdrawn: its queued push drops, or the one on the devices closes ([owner actions follow state](2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md)). The next row after a close alerts again. A tapped Implement leaves the row at once, since the row is recomputed from the board.
- **No batch window.** The row updates at once; the 5-minute window of the first grill is dropped. Ready and Merge no longer wait for the tick's end either (`ownerActions` loses `now`).
- **Quiet hours hold only the first alert.** The row's first push queues while pushes are held, as any `--now` push does. A silent push alerts nothing, so it goes through quiet hours, snoozes and the weekend (never while notifications are off); while the row's first push is still queued, a silent one rewrites that queued push instead (`hub/push.mjs` `deliver`), which goes out alerting when the hold ends. At the flush the row goes as itself (`hub/schedule.mjs` `notifications`): it is never folded into its board's `summary:<route>`, and never dropped as a held question push ([a held question push is left out of the summary](2026-11-12-0800-a-held-question-push-is-left-out-of-the-summary.md)), since it is the board's whole needs-you line.
- **Separate pushes stay separate.** Faults, session prompts (a session held on a tool approval) and the idle push keep their own notifications. The orchestrator-wait reminder and the Tap Done push are T-397's.
- **The CLI says it.** `kickflip push --silent` (with `--tag`) is the board's silent update; it can't be combined with `--now` or `--urgent`.
- **A file from before** (`{<tag>: {kind, ids}}`, a tag per card) counts as an open row when it held any tag, and those card tags are withdrawn, so the stacked notifications close on the first check after the update.

## Consequences

- A board shows one needs-you notification at most, and the phone sounds once per stretch of the board needing the owner, not once per card or question.
- A new question on a row already showing doesn't sound; the badge and the row's count carry it. Opting in to alerts per kind is T-431.
- Whether iOS honours `silent` for a home-screen web app is not yet checked on a phone; if it sounds anyway, the row still replaces itself rather than stacking.
- A row the owner swiped away comes back silently on the next change.

Considered:
- per-card pushes batched through a 5-minute window, flushed by one summarize step (the first grill's build notes);
- one row for the whole hub (t190-boards: one per board);
- re-alerting when a new kind of item joins the row (t190-realert: only the first push alerts).
