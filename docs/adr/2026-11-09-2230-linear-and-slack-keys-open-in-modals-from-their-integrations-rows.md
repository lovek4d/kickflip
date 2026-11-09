---
status: accepted
---

# Linear and Slack keys open in modals from their Integrations rows, and Keep awake sits in Health

The owner, after #475: "actually go back to modals for slack and linear keys, but only access via a link on the integrations row instead of its own section", and "also move the keep awake to the hub health section".

- Linear's key and Slack's token go back into the centred modals they had before #475, with no section or summary row of their own. Each opens from a button at the end of its Integrations row, in both states: **Add key** while none is saved, **Change key** otherwise (`keyButton` in `hub/readiness.mjs`'s rows). The modal's subtitle reads Integrations. The row's old fix link ("Add one in Hub settings › Linear") goes, since the button is the way in; the Notifications row keeps its Hub settings › Notifications fix link.
- `#linear` and `#slack` in a link, and the hub's no-JS redirects after saving a key, open the modals; `/_hub/settings#slack` still works through the legacy settings route. Messages that name where to add a key say Hub › Integrations › Linear or Slack.
- Keep awake is a toggle row in Health under the machine row, carrying its note, and the Hub row's Keeping awake line goes. Off macOS the row shows its reason in place of the toggle. `hubView` carries `awake: {on, unsupported}`, its POST still answers `/_hub/api/settings`'s JSON and the page reloads `/_hub/api/hub`; `settingsView` no longer carries `awake`. `#keep-awake` in a link scrolls to the Health row.
- Nothing sits between the boards and Hub settings.

This replaces [Keep awake, Linear and Slack sit inline on the Hub page](2026-11-09-2152-keep-awake-linear-and-slack-sit-inline-on-the-hub-page.md), and again [hub settings open as modals](2026-11-01-1221-hub-settings-open-as-modals.md)'s modal list for Keep awake.
