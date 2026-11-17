# Alerts opt in to sounding the live row as Implement or a merge joins

Card #1013 (T-431), a follow-up of [a board's needs-you pushes are one live row](2026-11-15-1300-a-boards-needs-you-pushes-are-one-live-row.md), whose only-the-first-push-alerts rule left "the owner may opt in to alerts for chosen kinds later". The grill offered three kinds: Implement needed, merge ready and new ticket. The owner dropped new ticket (t431-ticket), chose hub-wide switches (t431-scope-2), and asked for "one 'Alerts' row that opens a sheet of toggles" (t431-place). This amends the live-row ADR's **Only the first push alerts**.

## Decision

- **Two switches, hub-wide, off by default.** `alerts: {implement, merge}` in settings.json, beside `notifications`, read by `hub/schedule.mjs` `alertsOf` (a kind is on only when stored `true`) and saved one at a time by `hub/push.mjs` `setAlert` through `POST /_hub/settings/alerts kind=<kind>&value=on`. They are kept apart from `quiet` and `notifications` the way `overnight` is, so the quiet-hours settings shape (`validate`, `quietOf`) stays as it was.
- **What each covers.** Implement needed is a card whose Action needed is `implement` (Tap Implement). A prototype pick is not, though the row counts both as builds. Merge ready is `merge` and `steps`, which the row already groups as merges waiting on the owner (`board/domain.mjs` `ALERT_KINDS`).
- **An action joining sounds the open row once.** `data/action-pushes.json` keeps `items: {<tag>: kind}` beside `row`. On each check, `board/domain.mjs` `rowAlerts` lists the actions of a kind switched on that weren't in the row with that kind before. A card that turns into a merge counts as joining. When any are listed while the row is open, the update goes out unsilenced (`--now`, no `--silent`), even if the row's title, body and url came out the same. Otherwise it is silent as before. The switches are read from settings.json at every check. A file without `items` takes the row's actions now as already pushed, so turning up after the update sounds nothing.
- **Held like a first push.** An alert is a `--now` push, so quiet hours, the weekend and a snooze queue it (`hub/push.mjs` `deliver`) and it goes out alerting when the hold ends. While notifications are off it is dropped, as every push is.
- **One Alerts row.** Hub settings › Notifications ends with an Alerts row, whose sub names the kinds on or reads Off. It opens the Alerts sheet stacked on the modal (CONTEXT.md **Sheet stack**), with a line on what an alert does and the toggles "Implement needed" and "Merge ready".

## Consequences

- Nothing changes until the owner turns a switch on.
- With a switch on, a busy board can sound once per Implement or merge joining, which the live row otherwise prevented. That is the owner's choice per kind.
- T-509 (an iPhone's declarative push spike) changes how row updates reach iOS. Whichever of T-509 and this lands second reconciles with the other: under T-509's fallback, an opted-in alert is a new alert for Apple too.

Considered:
- a per-board switch (t431-scope-2: hub-wide);
- a toggle per kind directly under Push notifications (t431-place: one Alerts row opening a sheet);
- a new-ticket push (t431-ticket: dropped);
- recording only the kinds pushed, not each item: a second merge joining a row that already held one would not sound, though the notes ask for an alert per item joining.
