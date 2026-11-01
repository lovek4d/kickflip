---
status: superseded in part by ADR-0076
---

# Hub settings open as modals

Superseded in part by [0076](0076-snooze-is-five-chips-in-notifications.md): Snooze stays inline in Notifications instead of opening a sheet over its modal. The settings modals below still hold.

The owner picked take A of `prototype-hub-modals.html`: Hub’s five settings rows keep their one-line summaries and open centred modals. Controls show a label and value, without explanation lines. This keeps Hub’s health and status in place and gives the Polling schedule editor the same treatment as the other settings.

- Notifications, Polling, Codex share, Rules for every board and Closed boards each open the existing settings modal shell: title, ✕, its own scroll area and Done. `fitSheet`, the page scroll lock and `--app-bottom` keep it usable with a phone’s keyboard and bottom header. The snooze sheet opens over Notifications.
- Escape, the backdrop, ✕ and Done share the board settings modal’s unsaved-edits guard, including rules being edited. Closing restores focus to the row; leaving Hub also guards unsaved edits.
- `/_hub/settings` opens Notifications. `/_hub/settings#<section>` and `/_hub/#<section>` open that section’s modal through the same router, including notification pushes and stored links. Opening and closing replace the URL without adding history entries; closing restores `/_hub/`, and browser back keeps Hub’s existing behaviour.
- Polling’s schedule editor lives in its modal. `/_hub/settings/polling` still opens Hub with Polling open, and `?w=HH:MM` selects that window. The canonical URL is `/_hub/?w=HH:MM#polling`; picking a window replaces it. The POST routes keep saving at once, and their no-JS redirects reopen Polling.
- Notifications’ explanation lines, Polling’s notes and the Codex and Rules descriptions are removed inside the modals. The five row summaries remain on Hub.

This replaces [0074](0074-hub-settings-expand-in-place-and-board-settings-open-in-a-modal.md)’s “each expands in place” and Polling’s own page. Its board settings modal stays as decided.
