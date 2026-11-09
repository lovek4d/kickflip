# The overnight triage test swaps the pulled build after its hand-back

The "idle board triages overnight" test (board/server-stale.test.mjs) timed out about 1 in 10 runs with 32 copies running at once (10 of 96), and twice in land logs under the full suite.

Cause, read from the server's files at the timeout (the wait now prints them): the test fakes the pulled build going back to Todo by removing agents/A1.json and rewriting wave.json without the board's lock. The fake builder exits at once, so the server relaunches it once and hands it back (reviveHeadless). Under load that relaunch landed after the test's swap: launchBuilder rewrote A1's agent record and the card read In Progress with an open agent, so the board never read idle.

Decision: the cause is in the test. A real board takes a build back to Todo through its own locked commands, and the server never races its own writes. The test now waits for the hand-back (`handedBack` in headless-builders.json) before the swap. After the change, 96 of 96 runs under the same load passed.

The 80ms "nothing happens" ticks stay; this card fixes the timeout only.
