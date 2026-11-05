# One full suite at a time on the host

Since the Merge tap waits its turn (2026-11-04-2320), preparing a land (rebase and the full `node --test` suite) runs outside the land lock. Every lander on the host then ran its suite at once: with eight at a load average of 44-68 the timing tests in headless.test.mjs and server.test.mjs failed, every land refused, the landers retried, and the load stayed up. Nothing landed.

Decision: the suite run takes a host-wide test slot, `~/.claude/kickflip/test.lock` `{card, pid, at}`, queued first in first out in `test.queue` exactly like the land lock (one shared implementation in worktree.mjs). It covers the suite run only: the rebase stays outside it and the land lock is unchanged. A lock or ask whose process is gone is taken over. A land waiting for the slot says so on the card's thread, naming the card running its suite.

The timing tests that failed under load now wait on the event or file state they need, with a generous ceiling, instead of sleeping or using fixed timeouts.
