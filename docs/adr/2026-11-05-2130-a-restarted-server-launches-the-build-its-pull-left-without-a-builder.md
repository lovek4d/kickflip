# A restarted server launches the build its pull left without a builder

The hub restarts a board server when a land changes its code, and the same land frees the slot that sets off a pull. #274 and #284 were cut off between `startTappedBuild` (record open, `dispatched` set, card building) and `launchBuilder`/`trackLaunch`: the new server saw a building card that headless-builders.json didn't list, so nothing launched it.

At startup, `launchCutOffBuilds` (store.mjs `cutOffBuilds`) takes every building card whose main build record is open with `dispatched` still set (a builder's own `builder start` clears it) and that headless-builders.json doesn't list, and hands it to `handOff`, as the pull would have. Planners are left to their own path.

Chosen over putting the card back in Todo (owner answer gh296-recover). A SIGTERM handler was not chosen: it can't cover a crash.
