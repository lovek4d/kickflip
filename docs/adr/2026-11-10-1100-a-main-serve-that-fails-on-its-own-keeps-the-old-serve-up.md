# A Main serve that fails on its own keeps the old serve up

[Main serves again after the pair update](2026-11-10-0108-main-serves-again-after-the-pair-update.md) stopped the old serve and served once more for any new Main serve that exited before answering while the old one served. The hub can't tell a refused second server from a broken commit that way, so every broken commit took Visit down and left Main failed with nothing serving, overriding the owner's T-17 choice that a failed build keeps the old server up (T-73).

**The fallback fires only when the new serve's log names the old serve's worktree.** Next prints `Another next dev server is already running` with the other server's `Dir:`, and the old run's worktree is always the other of `<route>-main-a`/`-b`, so its path in the new serve's log marks a refusal without depending on Next's wording. Then the old run stops and the serve runs once more in the same worktree, as before. Any other exit before answering is Main's failure, and the old serve keeps answering with the bar reading Update failed beside Visit.

Considered and not taken: serving the old commit again after the retry fails (an outage on every broken commit while it restarts), and stopping the old serve before every new one (Visit down on every merge). The owner chose to keep the old serve up (t73-simpler).
