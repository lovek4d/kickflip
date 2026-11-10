# Main serves again after the pair update

The 0.7.4 update (#497, the alternating `<route>-main-a`/`-b` worktrees) left every web board's Main failing on a hub that updated in place (T-69):

- `launchMain` removed the single `<route>-main` worktree of the hub before the pair with `git worktree remove --force`, and threw when git refused (a folder git doesn't list as a worktree, a lock, a slow tree). Every Main launch failed the same way, forever.
- The old hub's Main server, started in `<route>-main`, outlived the update restart: that hub recorded no process groups, so the startup sweep (#498) couldn't find it. A new `next dev` in `-main-a` then refused to start, since Next allows one dev server per project, and the serve exited before answering.

**The old single worktree is cleared, never fatally.** Before it is removed, every process whose working directory (`lsof -d cwd` over all processes) or command line is inside `<route>-main` has its process group ended as a sweep ends a leftover group (SIGTERM, SIGKILL after 4s), and each is logged. Then `git worktree remove --force`; when git refuses, the folder is removed by hand and `git worktree prune` drops git's record. A failure in any step is logged and the launch goes on.

**A refused handover falls back to stopping the old serve first.** When Main's new serve exits before answering while the old run is serving, the old run is stopped and the serve runs once more, in the same worktree, with a line at the top of `data/try/main.log` saying so. A tool that allows one server per project then comes up, as a same-port build already did (the owner's call on T-17: "keep old, sameport fallback"). The second try is the only one: with no old run serving, its failure is Main's failure.

This replaces [a Main re-serve keeps the old server up until the new one answers](2026-11-09-1815-a-main-re-serve-keeps-the-old-server-up-until-the-new-one-answers.md)'s "A failed build keeps the old server": the hub can't tell a dev server that refused to share the project from a broken commit, so a new serve that fails while the old one serves stops it and tries once more either way. Main's bar now shows Failed beside Visit only when the new build couldn't start, such as a checkout git refused.
