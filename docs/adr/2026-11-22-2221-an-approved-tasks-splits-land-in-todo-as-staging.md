# An approved task's splits land in Todo as staging

Since #838 every task the orchestrator files from another, a split included, came in as an ask through New, which
triage then sorted grilling ([a task the orchestrator files comes in as an ask through New](2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md)).
A split of a task the owner had already approved was grilled again from New. The owner (T-545, decided 11/21) chose
that splits of an approved task only skip New, behind a hub setting they named "Automatically stage split tickets", on
by default, which a board can override. This is T-545's second split, T-807, built on T-806's Board defaults seam
([the Auto settings are hub defaults a board can override](2026-11-22-0130-the-auto-settings-are-hub-defaults-a-board-can-override.md)).

## Decision

- **An approved task is a staged one.** The orchestrator files a split while judging a staged task whose notes answer
  it Split as proposed, so the Parent's phase being staging is the test.
- **The setting is a Board default, `stage_splits`.** It joins `BOARD_DEFAULT_KEYS` in `shared/hub-settings.mjs`, whose
  built-ins are now per key (`BOARD_DEFAULT_BUILT_INS`): `stage_splits` on until set, the Auto settings off. Hub
  settings' Board defaults draws it after Idle notification, and Board settings' Overrides draws it Hub default (its
  value), On, Off; `settings set stage-splits on|off|default` sets it from the CLI.
- **It wakes no session.** `item add` reads it as it files, so neither a Board settings save nor a hub default change
  writes a `settings` event for it (`board/settings.mjs` SILENT_DEFAULTS, beside idle_notification). The watcher still
  prints `setting stage-splits on|off` with every wake.
- **On, a split files staged.** `item add <file> --title <t> --notes-from <slice> --parent <key> --split --phase staging`
  is the one staging an agent may file (`board/cards.mjs` createItem): the card goes to Todo as staging with its Parent
  and copied gates, Created ticket and Created from lines, then a Marked as staged line, newest, whose time is its
  `staged_at`. It needs no `--relate`, since its Parent names where it came from. The orchestrator then judges it as
  any staged task.
- **Each form refuses while the other is the board's.** The staged form is refused for a Parent not staging, or with
  the setting off, naming the `--ask` form; `--ask --split` of a staged Parent is refused while the setting is on,
  naming the staged form (`refuseAskedSplit`). A follow-up (`--ask --parent` without `--split`) and a split of a task
  not staging still come in as asks.

Amends [a task the orchestrator files comes in as an ask through New](2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md).

## Left out

- Owner-requested follow-ups and the orchestrator's own findings still come in through New (the owner's answer: splits
  of an approved task only).
- `item triage --split` of a New card is unchanged: an ask already in New is sorted as before.
