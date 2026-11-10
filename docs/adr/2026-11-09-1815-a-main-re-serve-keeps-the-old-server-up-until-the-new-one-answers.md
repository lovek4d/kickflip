# A Main re-serve keeps the old server up until the new one answers

Main went dark on every merge (#493, #497). `launchMain` stopped the old run, checked the new tip out into the one Main worktree, `~/.claude/kickflip/try/<route>-main`, and built it there. Until the new server answered, nothing served Main's fixed port, so the owner's Visit got a 502 ("visit is giving 502, not slow").

**Overlap, then swap.** Main now builds each new tip in the other of two detached worktrees, `<route>-main-a` and `<route>-main-b`, and its ready run moves aside (try.mjs `serving`) while the new one builds. Once the new port answers, the new run's relay takes Main's fixed https port (`tailscale serve --bg` replaces the mapping), try.json reads ready on the new port, and the old run is stopped. Its close leaves the port's mapping alone, since another run now holds it. A hub from before the pair has its single `<route>-main` worktree removed on the next Main build.

**A failed build keeps the old server.** The old run stays serving, and try.json's main entry, failed at the new sha, keeps `serving: {sha, at, https}`. A retry builds in the worktree the old server isn't using.

**Same port: stop, then serve.** A new build that prints the old server's port can't overlap it, and the probe would hear the old server answer. For that build the old run is stopped first, and the probe starts once it's gone.

**The bar.** While `serving` is set, Main's bar names the old server's commit and time, and shows Visit to it with a Serving… chip, or a Failed button that opens the log, left of Visit (take A of the main-reserve-bar round, the chip left of Visit per the owner's note). The log sheet still names the failed sha.

**No old server outlives its hub.** A stopping hub stops the old run too, and the next hub drops `serving` from try.json. A Main whose new build failed before the restart therefore shows Failed with no Visit until a retry or the next merge, as before this change.

This supersedes [a board's build script serves or builds each card and main](2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md)'s single Main worktree and its stop-before-checkout.
