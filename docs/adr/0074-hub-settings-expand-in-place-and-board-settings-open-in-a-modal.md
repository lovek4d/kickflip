---
status: superseded in part by ADR-0075 and ADR-0081
---

# Hub settings expand in place and board settings open in a modal

Superseded in part by [0075](0075-hub-settings-open-as-modals.md): Hub’s rows open modals, Polling’s editor included, and no hub settings row expands in place. The board settings modal below still holds.

Superseded in part by [0081](0081-a-board-has-one-ticket-source.md): Board Settings also holds the board's Tickets row.

The owner picked take B of `prototype-settings-2.html`: hub settings belong below Hub’s existing health and status, while each board’s settings belong over that board. Separate Settings pages and a combined Board/Hub dialog split context or mix scopes.

- The sidebar starts with Hub and has no Settings row. Hub stays selected on the hub page and Polling, and its sub line shows when notifications are off or blocked on this device. A moon after its name marks pushes held or snoozed. Turn on notifications opens Hub’s Notifications row.
- Hub keeps health and status first, followed by five collapsed rows with one-line summaries: Notifications, Polling, Codex share, Rules for every board and Closed boards. Each expands in place. Polling’s row opens its existing schedule editor.
- `/_hub/settings` opens Hub with Notifications expanded; `/_hub/settings#<section>` and `/_hub/#<section>` expand and scroll to that row. Notification pushes and stored links keep working through the same router. These rows preserve Hub’s existing back behaviour.
- The board header’s gear opens a centred modal at every width, with its own scroll area on a phone. It contains only the board’s own controls: its repo and branch ([0073](0073-a-new-board-chooses-a-repo-and-branch.md)), auto-merge, install script, reviewers, rules and Close board. Hub rules are edited on Hub.
- `/<board>/settings.html` opens the board with that modal open. Opening from its board replaces the URL, and closing restores the underlying board URL and open card; neither adds a history entry. Unsaved edits ask before closing or leaving. Escape, the backdrop, the close button and Done share that guard, and dismissal restores focus.
- The modal uses the visual viewport and keyboard handling in `fitSheet`, retains the modal page scroll lock and clears the phone’s bottom header through `--app-bottom`. Closed boards live on Hub, and the Close confirmation says “Reopen later from Hub → Closed boards”.

This replaces the Settings placement in 0021, 0039, 0050, 0055, 0070 and 0072: the hub’s pages carry no gear. The page tree in 0058 stays intact.
