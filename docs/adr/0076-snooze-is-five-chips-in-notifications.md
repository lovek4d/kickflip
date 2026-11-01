# Snooze is five chips in Notifications

The owner picked take A of `prototype-snooze.html` on hub/INT-186, with "options should be 3h 6h 1d Monday Custom". Snooze sits in Hub's Notifications modal as five chips, so one tap snoozes without a second sheet over the modal.

- **3h**, **6h**, **1d** and **Monday** snooze at once. 1d is 24 elapsed hours; Monday is the first window's next start on a Monday.
- **Custom** opens the device's date-and-time picker, set to an hour from now, and posts the chosen time as a UTC ISO date-time. `hub/schedule.mjs` `snoozeEnd` checks every choice and refuses an end not after now or more than 30 days on.
- Snoozed, the row reads "Snoozed until 3:10pm", with the day when not today, and **End**. To change a snooze, End it and pick again.

This replaces [0032](0032-notifications-can-be-off-snoozed-or-off-on-weekends.md)'s sheet, choice list and Extend, and [0075](0075-hub-settings-open-as-modals.md)'s snooze sheet over Notifications. `web-ts notifications snooze` keeps taking 0032's choices.
