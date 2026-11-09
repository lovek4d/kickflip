---
status: accepted
---

# Keep awake, Linear and Slack sit inline on the Hub page

The owner asked that Keep awake, Linear and Slack not sit under modals: they go to the root of the Hub page, between the boards and Hub settings, and the Polling status row goes.

- Keep awake's toggle and note, Linear's key field and Slack's token field, each with its note, render on the page itself, in that order, under the Sessions without a board list and above the Hub settings heading. They save at once as before (`/_hub/settings/keep-awake`, `/_hub/settings/linear`, `/_hub/settings/slack`). On a host other than macOS Keep awake shows its reason in place of the toggle.
- Hub settings keeps summary rows and modals for Pause hub, Notifications, Quiet hours, Rules for every board and Closed boards. `#keep-awake`, `#linear` and `#slack` in a link now scroll to the inline row instead of opening a modal.
- The Polling status heading and row go, with `hubView`'s `polling` data, the cadence and poll-line words that fed it, and the page's Send now button. `POST /_hub/push/flush`, `node $KF poll-now` and Quiet hours' cadence hint stay.

This replaces [hub settings open as modals](2026-11-01-1221-hub-settings-open-as-modals.md)'s modals for these three.
