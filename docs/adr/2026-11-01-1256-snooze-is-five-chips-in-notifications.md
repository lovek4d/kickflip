---
status: superseded in part by 2026-11-01-1948-snooze-is-six-chips-in-a-three-column-grid
---

# Snooze is five chips in Notifications

Superseded in part by [snooze is six chips in a three-column grid](2026-11-01-1948-snooze-is-six-chips-in-a-three-column-grid.md): Snooze has six chips, 3d added before Monday, in a three-column grid. Custom and the snoozed row below still hold.

The owner picked take A of `prototype-snooze.html` on hub/INT-186, with "options should be 3h 6h 1d Monday Custom". Snooze sits in Hub's Notifications modal as five chips, so one tap snoozes without a second sheet over the modal.

- **3h**, **6h**, **1d** and **Monday** snooze at once. 1d is 24 elapsed hours; Monday is the first window's next start on a Monday.
- **Custom** opens the device's date-and-time picker, set to an hour from now, and posts the chosen time as a UTC ISO date-time. `hub/schedule.mjs` `snoozeEnd` checks every choice and refuses an end not after now or more than 30 days on.
- Snoozed, the row reads "Snoozed until 3:10pm", with the day when not today, and **End**. To change a snooze, End it and pick again.

This replaces [notifications can be off, snoozed, or off on weekends](2026-10-29-1639-notifications-can-be-off-snoozed-or-off-on-weekends.md)'s sheet, choice list and Extend, and [hub settings open as modals](2026-11-01-1221-hub-settings-open-as-modals.md)'s snooze sheet over Notifications. `web-ts notifications snooze` keeps taking [notifications can be off, snoozed, or off on weekends](2026-10-29-1639-notifications-can-be-off-snoozed-or-off-on-weekends.md)'s choices.
