---
status: superseded in part by 2026-11-01-1221-hub-settings-open-as-modals, 2026-11-01-1348-a-board-has-one-ticket-source and 2026-11-01-1842-the-page-scrolls-behind-a-modal-from-900px
---

# Hub settings expand in place and board settings open in a modal

Superseded in part by [hub settings open as modals](2026-11-01-1221-hub-settings-open-as-modals.md): Hub’s rows open modals, Polling’s editor included, and no hub settings row expands in place. The board settings modal below still holds.

Superseded in part by [a board has one ticket source](2026-11-01-1348-a-board-has-one-ticket-source.md): Board Settings also holds the board's Tickets row.

Superseded in part by [the page scrolls behind a modal from 900px](2026-11-01-1842-the-page-scrolls-behind-a-modal-from-900px.md): The page scrolls behind every modal from 900px; the page scroll lock stays below 900px.

The owner picked take B of `prototype-settings-2.html`: hub settings belong below Hub’s existing health and status, while each board’s settings belong over that board. Separate Settings pages and a combined Board/Hub dialog split context or mix scopes.

- The sidebar starts with Hub and has no Settings row. Hub stays selected on the hub page and Polling, and its sub line shows when notifications are off or blocked on this device. A moon after its name marks pushes held or snoozed. Turn on notifications opens Hub’s Notifications row.
- Hub keeps health and status first, followed by five collapsed rows with one-line summaries: Notifications, Polling, Codex share, Rules for every board and Closed boards. Each expands in place. Polling’s row opens its existing schedule editor.
- `/_hub/settings` opens Hub with Notifications expanded; `/_hub/settings#<section>` and `/_hub/#<section>` expand and scroll to that row. Notification pushes and stored links keep working through the same router. These rows preserve Hub’s existing back behaviour.
- The board header’s gear opens a centred modal at every width, with its own scroll area on a phone. It contains only the board’s own controls: its repo and branch ([a new board chooses a repo and branch](2026-10-31-1636-a-new-board-chooses-a-repo-and-branch.md)), auto-merge, install script, reviewers, rules and Close board. Hub rules are edited on Hub.
- `/<board>/settings.html` opens the board with that modal open. Opening from its board replaces the URL, and closing restores the underlying board URL and open card; neither adds a history entry. Unsaved edits ask before closing or leaving. Escape, the backdrop, the close button and Done share that guard, and dismissal restores focus.
- The modal uses the visual viewport and keyboard handling in `fitSheet`, retains the modal page scroll lock and clears the phone’s bottom header through `--app-bottom`. Closed boards live on Hub, and the Close confirmation says “Reopen later from Hub → Closed boards”.

This replaces the Settings placement in [the board shows GitHub checks and Claude's activity, with one refresh](2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md), [rules live on Settings, at hub and board level](2026-10-29-1639-rules-live-on-settings-at-hub-and-board-level.md), [a sidebar of every board replaces the hub home](2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md), [one app for the whole hub](2026-10-29-2005-one-app-for-the-whole-hub.md), [phone headers sit at the bottom, with boards nearest the thumb](2026-10-31-1532-phone-headers-sit-at-the-bottom.md) and [a closed board keeps its folder and can be reopened](2026-10-31-1603-a-closed-board-keeps-its-folder-and-can-be-reopened.md): the hub’s pages carry no gear. The page tree in [Back follows the page tree](2026-10-30-1125-back-follows-the-page-tree.md) stays intact.
