# The header's waking and a GitHub check request come from the server

The browser draws what the server sends and computes none of it (T-322's audit).

- **Waking.** The header reads `checks.watcher`: `waking` once the hub took the wake (`listenState`, resume-state.json), `asleep` before. A tap's wake request keeps a client guard so it is sent once, but the guard no longer reaches the header.
- **GitHub check.** `/api/board`'s `checks.requested` is `{at, state}` for the newest page-sent `check-github` event (a daily wake's and auto-merge's carry a `reason` and aren't requests). `pending` until `checked.json` lands at or after `at`, `landed` then, and `gave-up` once five minutes pass unanswered (`withHub`, recomputed each read since the shared build is cached). The spinner and "Checking…" read `pending`; the page keeps no timer.
- **Kept in the browser.** The header time's orange `late` mark is the age of this device's last update, which is about the device.

Consequence: between a wake tap and the board's reload the header still reads asleep, and the spinner draws when the send's answer carries the request.
