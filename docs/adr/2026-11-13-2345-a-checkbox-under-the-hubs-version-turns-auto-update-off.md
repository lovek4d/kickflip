# A checkbox under the hub's version turns auto update off

Changes the footer and the tick's pull in [an npm hub pulls only once the owner has been away 15 minutes](2026-11-12-0300-an-npm-hub-pulls-only-once-the-owner-has-been-away-15-minutes.md): the check, its cadence, the away rule for a pull, the hung-pull kill and the clone rule stand. That ADR's "Nothing shows on the hub page while a newer version waits" no longer holds.

- **Stored** as `autoUpdate: false` in `~/.claude/kickflip/settings.json`; unset is on (today's behaviour). Turning it on removes the key. `POST /_hub/settings/auto-update` (`auto_update=on`) writes it; the hub page's data carries `update: {latest, auto, clone}`.
- **Off** means the tick's check still runs and still finds the newer version, but neither it nor the 15-second tick pulls. A version tap pulls once, with no confirmation. Turned back on, a version a check already held pulls under the usual away rule.
- **The footer** is two ordinary lines at 12px with no extra spacing. Line one is a single button, `kickflip.sh / 0.13.0 > 0.14.0 (new)`: the newer version npm has (blue, info) shows whenever one exists, auto update on or off, and the button's tap pulls. The tap answers in place with the footer's inline note (`pulling 0.14.0…` in orange, `up to date`), never a toast. `kickflip.sh` is plain text there, since a link can't sit inside a button. Line two is `auto update` with its checkbox, hidden on a clone, which never pulls.
- **The version** loses its `v` prefix, as drawn in the prototype.
