# Snooze and Keep awake share one duration picker

The owner asked on hub/INT-246 for a Keep awake setting that "runs caffeinate -ims for the duration requested, same format as snooze", off by default and able to run "indefinite … instead of 3 day", and for Snooze to get the same choices: "DRY. 1hr/3hr/6hr/1day/forever/custom".

- **One picker.** Snooze, in the Notifications modal, and Keep awake offer the same six chips in the same three-column grid: **1h**, **3h**, **6h**, **1d**, **Forever** and **Custom**, the native date-and-time picker up to 30 days on. `hub/duration.mjs` holds the chips and when each choice ends; `durationPicker` in `board/public/view-hub-settings.js` lays out both. 3d and Monday go from the chips; `kickflip notifications snooze` still takes `monday`, `tonight`, `morning` and other lengths.
- **Forever** is stored as `forever` in place of a time, and lasts until the owner ends it. A forever snooze queues pushes the way a timed one does, and they go once it ends.
- **Keep awake is its own row** in Hub settings, between Polling and Linear, opening a modal with the picker (take A of `keep-awake`). While it is on, the modal says until when with Turn off, the row reads On until a time or On · forever, and Hub's Health row says Keeping awake. Its tile is grey while off and orange while on, as the machine working ([0096](0096-colour-says-whos-waiting.md)).
- **The hub owns caffeinate.** `hub/awake.mjs` runs one `caffeinate -ims -w <hub pid>` while `keep_awake_until` in `~/.claude/kickflip/settings.json` is `forever` or a time still ahead. It stops it at that time or when turned off, and clears the setting once the time passes. Only the end is stored, never a pid: a restarted hub starts caffeinate again while time is left, and `-w` ends caffeinate with the hub that started it.
- **macOS only.** Only macOS has caffeinate; on other hosts the row is disabled and says so, and the hub refuses the setting.

This supersedes in part [0100](0100-snooze-is-six-chips-in-a-three-column-grid.md): its six chips become these, and its grid stays.

Considered: Keep awake as a row in the Notifications modal under Snooze (take B of `keep-awake`). The owner chose its own row (take A).
