# A pulled card whose launch was lost launches again

Superseded by 2026-11-18-2000-builder-start-takes-up-a-launch.md: every card In Progress with nothing building it restarts in place, this one included.

#797 was pulled (the thread line "Moved to In Progress: slot available") one second before the board server restarted. `startBuilder` moves the card into In Progress before it makes the worktree and writes the builder record, so the restart left a card In Progress with no agent record at all. `launchCutOffBuilds` (2026-11-05-2130) only takes a record that is open and still `dispatched`, so nothing launched it, and it held a slot for over an hour.

`launchLostBuilds` (store.mjs `lostLaunches`) takes every open card In Progress with no agent record of any kind, not held by the owner and not blocked, and starts it as the pull would have (`startTappedBuild`, dispatched `hub`, then `handOff`). It runs at boot, where nothing else of this process is mid-start, and each minute, where a card that entered the lane within two minutes is left alone since a start may still be under way. It skips a launch the usage gate holds.

The same restart logged "Headless builder check failed: ENOENT … rename 'headless-builders.json.tmp'": `trackLaunch` and `reviveHeadless` both wrote the file through one shared `.tmp` name, so the second rename found it gone. Each write now has a tmp name of its own.

Chosen over writing the pull's marker and the builder record in one step: the record needs the worktree, which can take seconds, so a restart can still land between the lane move and the record; the recovery covers every such cut, whatever moved the card.
