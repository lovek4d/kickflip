---
status: superseded in part by 2026-11-02-1402-snooze-and-keep-awake-share-one-duration-picker
---

# Snooze is six chips in a three-column grid

Superseded in part by [snooze and Keep awake share one duration picker](2026-11-02-1402-snooze-and-keep-awake-share-one-duration-picker.md): the chips are 1h, 3h, 6h, 1d, Forever and Custom, shared with Keep awake. The grid still holds.

The owner asked on hub/INT-233: "In Snooze add 3 days before Monday for a square 6". Snooze in Hub's Notifications modal offers **3h**, **6h**, **1d**, **3d**, **Monday** and **Custom**.

- **3d** is 72 elapsed hours, as `hub/schedule.mjs` `snoozeEnd` reads `<n>d`. It snoozes at once like the other chips.
- The chips sit in a grid of three columns at every width, so the six make two rows of three.

This replaces [snooze is five chips in Notifications](2026-11-01-1256-snooze-is-five-chips-in-notifications.md)'s five chips. Its Custom picker, 30-day limit and snoozed row still hold.
