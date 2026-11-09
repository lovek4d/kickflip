# Keep awake is a toggle that holds the Mac awake only on AC power

The owner asked on #444: "is there a caffeinate variant that only keeps awake when on ac power? can we use that instead? and turn it into just a toggle instead of a snooze type choice?"

- **`caffeinate -s`.** `man caffeinate` says `-s` is "valid only when system is running on AC power". The hub runs `caffeinate -s -w <hub pid>` in place of `-ims`: on battery it holds nothing, and it holds again on plug-in with no restart. `-i` and `-m` hold on battery too.
- **A toggle.** Keep awake is on or off, stored as `keep_awake: true` in `~/.claude/kickflip/settings.json` in place of `keep_awake_until`. Its modal holds one checkbox row like Push notifications (take A of `keep-awake`) and a note that it holds the Mac awake only on AC power. The row reads On or Off and Hub's Health row says Keeping awake: fixed words, with no read of the power source.
- **Migration.** On its first apply the hub drops `keep_awake_until`: `forever` becomes `keep_awake: true`, a timed value becomes off, since the hub's Keep awake was its only writer and none is left to carry over.
- **`POST /_hub/settings/keep-awake`** takes `keep_awake=on`; anything else is off. The 30-day refusal goes, the 409 off macOS stays. `awake.mjs` has no end timer.
- **Snooze, Pause hub and Hold keep the duration picker** (`hub/duration.mjs`).

This supersedes [Snooze and Keep awake share one duration picker](2026-11-02-1402-snooze-and-keep-awake-share-one-duration-picker.md) in its Keep awake part: the picker, `keep_awake_until` and `caffeinate -ims` go; Snooze keeps the six chips.
