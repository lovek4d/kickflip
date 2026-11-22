# The Auto settings are hub defaults a board can override

Auto serve, Auto review, Auto-merge and Idle notification were each a board's own switch in board.json, off when
absent, set in Board settings' Auto section. The owner wants settings of this kind set once for the hub, with a board
offering only overrides (T-545, decided 11/21; this is its first split, T-806).

## Decision

- Hub settings.json keeps `boardDefaults`, `{auto_build, auto_review, auto_merge, idle_notification}` keyed as board.json
  keys them, a key unset reading off (`shared/hub-settings.mjs` readBoardDefaults, setBoardDefault).
- A board's value is its override, a boolean stored in board.json, else the hub's default. `board/settings.mjs`
  settingsOf and `hub/boards.mjs` listBoards both read it that way, so every reader (the hub's tick and incoming PR
  poll, the board server's idle check, finish, the snapshot, the watcher's `setting` lines) takes it with no change of
  its own. `overridesOf(cfg)` names what a board overrides.
- An override is dropped by POST api/settings with the key `null`, or `settings set <key> default`. An override equal
  to the hub's value stays an override: it keeps the board where it is when the default later moves.
- Hub settings' **Board defaults** section sits right under Usage, above Capacity. It holds Builders and Orchestrators,
  moved out of the Usage card, then each Auto setting as On and Off, drawn by the same `modelControl`. Each posts
  `value=on|off` to `/_hub/settings/<key, dashed>` (`board/settings.mjs` saveBoardDefault). A board without an
  override whose value moved hears it as a Board settings save would tell it: a `settings {<key>: value}` event, none
  for idle_notification, and `check-github {reason: "auto-merge"}` when Auto-merge turned on.
- Board settings' Auto section becomes a collapsed **Overrides** group whose head counts the overrides
  ("Overrides · 1", "Overrides · none"). Each setting is drawn as the models are: Hub default (its value) first, then
  On and Off. Only a tap that turns Auto-merge on asks first, as the old toggle did.
- Migration, once, at the hub's start while settings.json has no `boardDefaults`: the defaults start at the
  built-ins, all off, so each board in the manifest drops the keys it stores off and keeps those it stores on as
  overrides; `boardDefaults: {}` then marks it done (`migrateBoardDefaults`).
- Maximum parallel land tests and the models were already Hub settings only
  ([models and land tests are hub settings only](2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md));
  they get no override.

## Left out

- "Automatically stage split tickets", the filing setting, is T-807's, built on this seam.
- Hub settings' Auto-merge On asks nothing, unlike a board's: the section's controls save as Builders does.
- A closed board isn't in the manifest, so the migration skips it; reopened later, a stored off reads as an override.
