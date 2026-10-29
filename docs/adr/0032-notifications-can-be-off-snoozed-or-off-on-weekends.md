# Notifications can be off, snoozed, or off on weekends

hub Settings (`/_hub/settings`) has three Notifications controls beside the polling interval. They are stored as `notifications` (`{on, weekends_off, snoozed_until}`) beside `polling` in `~/.claude/web-ts/settings.json`, and `hub/schedule.mjs` `validate` checks them. `web-ts notifications` sets them from the terminal, and `web-ts polling` prints them.

- **Off.** Every push is dropped, urgent ones included, and turning notifications off drops the queue too. Nothing waits to arrive when they come back on: a pile of old pushes after an off would be noise, and Needs you already holds whatever still waits.
- **Snooze**, up to 30 days. Pushes queue until it ends, then go at the next polling slot. The Snooze row opens a sheet of choices, each showing when it ends: 1 hour, 3 hours, until tonight (the evening window's next start: the second-to-last window, or the second of two; shown only while that is today, and never with one window), until morning (the first window's next start), until Monday (at the first window's start), 1 week, or a chosen date and time. `hub/schedule.mjs` `snoozeEnd` turns a choice into its end and refuses one that ends in the past or more than 30 days on; `web-ts notifications snooze <choice>` takes the same choices. While snoozed, a banner above Notifications reads "Snoozed until <time>" with **Extend**, which opens the sheet with only the choices that end later, and **End**.
- **Off on weekends** (off by default). Pushes queue from Friday at the last window's start until Monday at the first window's start: Friday 10pm to Monday 8am with the default windows. These are the overnight hold's edges ([0025](0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md)), so the weekend is one long overnight and the queue goes out on the same Monday slot. It works whether or not Hold pushes overnight is on. With it off, the same hours apply every day, as before ([0030](0030-pushes-go-by-kind-and-each-arrives-on-its-own.md)).

`schedule.mjs` `heldUntil` stays the one gate. Off makes it return `NEVER`, and `hold` gives the reason, so callers can print "snoozed until 3:00pm". When one hold ends inside another, such as a snooze ending at 11pm, the push waits for the later end. `--urgent` goes through a snooze, the weekend and the overnight hold, but not through off. Off means silence, and urgent stays for a production problem worth waking up for ([0006](0006-pushes-only-when-something-waits-on-the-owner.md)).

Only pushes are gated. GitHub checks, `github-change` events, the daily wakes, the board's Needs you and the Home Screen badge carry on. The morning digest is still written and goes through the same gate as any push. Replies still fold into the next push that goes ([0011](0011-replies-ride-along-on-the-next-push.md)). Turning notifications off asks to confirm through the shared dialogs (`/_hub/dialogs.js`). Snooze, End and the weekend toggle need no confirmation, since each one is undone with a tap or two.

The owner asked for this in a free note on round `site-v23`: "Also offer toggling notifications on and off, off on weekends, and snooze for hours/days" (owner, round site-v23 note, card INT-72).

Considered:
- off queuing pushes until notifications come back on;
- urgent pushes going through off;
- a weekend from Saturday 00:00 to Monday's first wake time. Those edges match neither the overnight hold nor the polling windows.
