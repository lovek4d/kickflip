# A lander the usage pause stopped starts again

A headless lander that the usage pause ends leaves its card at building with no process. launchLanders only picks cards at checking, and data/landers.json already holds the verification's time, so nothing launched it again.

`data/landers.json` now holds `{verified, pid}` per card. Each pass of launchLanders (which does not run while usage is paused) sends a card whose lander process is gone while the card still reads building back to checking (store.mjs `relaunchLander`), drops its entry, and launches a fresh lander in the same pass. `board.mjs lander <wave>/<id>` does the same by hand. A lander that exited at building without having been stopped by the pause relaunches the same way: building with no process is never a state worth keeping.

Superseded in part by [a card stores its lane, and facts replace statuses](2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): a stopped lander's open record is closed with handed_back again, not sent back to checking.

Superseded in part by [one land step decides a verified card's land](2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md): the entry is kept with its relaunch count, the relaunch is a fresh lander once, and a second exit is a fault; only `board.mjs lander` drops the entry.
