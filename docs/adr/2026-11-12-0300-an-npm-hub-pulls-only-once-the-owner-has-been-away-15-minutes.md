# An npm hub pulls only once the owner has been away 15 minutes

Changes the pull in [the npm check rides the hub's tick every 15 wall-clock minutes](2026-11-12-0110-the-npm-check-rides-the-hubs-tick-every-15-wall-clock-minutes.md): the check, its cadence, the hung-pull kill, the clone rule and the self-restart stand.

The hub reads board/public files from disk on each request, so an `npm i -g` while the owner is here changes the pages under the running old hub, and the restart that follows drops Main handovers mid-use. The check still runs on its schedule, but the pull waits.

- **What waits**: the whole pull (install, then the self-restart), not just the restart.
- **Away**: the hub's own reading (presence.mjs `ownerTracker`: the Mac locked or idle 3 minutes, and no board or Hub page beat in 3 minutes). The tracker gains `awaySince`, when that reading last turned away (the hub's start, until a reading says present). The pull waits for 15 minutes of it, so about 18 minutes after the owner's last key or tap. Quiet hours need no rule: the owner is away then. Where ioreg fails, as on Linux, only page beats keep the owner present.
- **When it fires**: a tick's check that finds a newer version remembers it; the 15-second tick pulls it the moment away reaches 15 minutes, not at the next check. Coming back mid-pull doesn't stop it.
- **A version tap** (the hub page's check) still pulls at once, present or not, since the owner asked.
- **Nothing shows** on the hub page while a newer version waits.
