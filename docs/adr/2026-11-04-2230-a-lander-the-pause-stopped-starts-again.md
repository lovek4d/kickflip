# A lander the usage pause stopped starts again

A headless lander that the usage pause ends leaves its card at building with no process. launchLanders only picks cards at checking, and data/landers.json already holds the verification's time, so nothing launched it again.

`data/landers.json` now holds `{verified, pid}` per card. Each pass of launchLanders (which does not run while usage is paused) sends a card whose lander process is gone while the card still reads building back to checking (store.mjs `relaunchLander`), drops its entry, and launches a fresh lander in the same pass. `board.mjs lander <wave>/<id>` does the same by hand. A lander that exited at building without having been stopped by the pause relaunches the same way: building with no process is never a state worth keeping.
