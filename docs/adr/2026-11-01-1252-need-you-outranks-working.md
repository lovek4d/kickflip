# "N need you" outranks Working

The owner picked option A of `need-you-word` on hub/INT-190: a site row's status word shows how many things wait on the owner whenever any do, whatever Claude is doing. An active board's session is nearly always working, so with Working first the count was almost never shown.

- `siteStatus` in `hub/home.mjs` picks the first that holds: Down, Not listening, Starting, Stopped, "N need you", Working, Asleep, Building.
- Working shows only while nothing waits on the owner.
- The rest of [the hub home shows status, not descriptions](2026-10-29-1639-the-hub-home-shows-status-not-descriptions.md)'s order stays as decided.
