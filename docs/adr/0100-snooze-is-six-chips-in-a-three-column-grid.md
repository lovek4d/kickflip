# Snooze is six chips in a three-column grid

The owner asked on hub/INT-233: "In Snooze add 3 days before Monday for a square 6". Snooze in Hub's Notifications modal offers **3h**, **6h**, **1d**, **3d**, **Monday** and **Custom**.

- **3d** is 72 elapsed hours, as `hub/schedule.mjs` `snoozeEnd` reads `<n>d`. It snoozes at once like the other chips.
- The chips sit in a grid of three columns at every width, so the six make two rows of three.

This replaces [0076](0076-snooze-is-five-chips-in-notifications.md)'s five chips. Its Custom picker, 30-day limit and snoozed row still hold.
