# kickflip waits for a slow hub

`kickflip` read the hub's `/_hub/status.json` with a 1.5 s limit, and a hub slower than that read as not running: `kickflip join` refused ("the hub is not running"), a page join printed `hub: NOT running`, and a queued push warned that nothing would send it. On a loaded host the hub was running and only slow, so a join failed for no reason, and every join test could flip on load (docs/test-determinism-audit.md, finding 3).

The read now has no time limit. A hub that is down refuses the connection at once, so it still reads as not running straight away; a hub that is up and slow is waited for. The cost is a hub that accepts the connection and never answers, which now holds the command until it is stopped, where before it gave up after 1.5 s. That hub is broken in a way `kickflip doctor` names; it isn't one a join should silently read as down.

`bin/install.mjs`'s own `hubStatus`, which install and doctor use, keeps its limit; it takes `fetch`, so its tests don't depend on it.

Test: bin/hub-status.test.mjs, with a preloaded fetch that cuts off any read carrying a time limit, as a hub slower than any limit would be.
