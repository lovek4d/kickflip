---
status: superseded in part by 2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent
---

# A tap spins until the board shows its change

Superseded in part by [a thread message shows at once, and the browser keeps it until it is sent](2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md): thread Reply and quick replies no longer wait; the message shows at once as sending…, and only Implement with text waits, on its own message.

A button that waited on its request alone went back to idle when the request returned, then showed the change a board later: a flash of the plain button between. And a request that outlived its change kept spinning well after the change showed: the server writes a Prototype request's status line, then keeps the request open while it moves the card and rebuilds the board, so the thread showed the line long before the spinner stopped (card #606).

**One helper, `B.spinUntil(button, {send, shows})` (app.js).** Every board tap that moves a card or asks for an agent goes through it. It runs `send()` and spins the button (`BoardUI.waitOn`, through any repaint) until `shows()` holds or `send()` fails, whichever comes first.

- **`shows()` compares with what the tap saw**, never with a fixed state, so a board or thread from before the tap never ends it. It is asked after every board render, every thread load and once `send()` resolves.
- **A refusal rests it**, with the reason in a toast, as before; a refusal that comes after the change showed still toasts.
- **Sixty seconds without either** rests it, reloads once and toasts "Still waiting on the board" (`BoardUI.pending.within`, `PENDING_LATE_MS`).

Each tap ends on the change it caused:

- **Prototype, Grill and Visual requests:** a line the card's thread didn't have when tapped.
- **Hold and Unhold:** the card's hold or its time changed. **Done and Reopen:** the card in another lane. **Bump and Unbump:** the card bumped or not.
- **Merge:** the card merging, which its markup then draws busy until it lands ([a merge tap waits its turn to land](2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md)), or gone from In Review.
- **Serve / Build and Kill:** the card's `try` changed; the busy host's question declined, or the serve cap's refusal, ends it with nothing to show.
- **Main's pull:** Main's pull, sha, state or time moved; a pull that brought no commits ends on its answer (`{commits: 0}`, a pull no board shows).
- **Plan waves:** a grill runs on one of the cards that wasn't grilling when tapped.

`BoardUI.pending`'s keyed entries (`start`, `answered`, `settle`), drawn busy by the markup, are gone: `waitOn` already finds a repainted button again by its id and data attributes, so one mechanism serves every tap. `pending.within(work, onLate)` stays as the sixty second rule.

**Out of scope.** Thread messages, quick replies and Implement are T-234's (#603), as above. Off the board, taps whose change a page load draws wait on that load through `pending.within`: the Questions page's Send, Prototype and Re-ask wait through the page moving on, which needs the POST's board; the permission switches wait through drawing the answer; a board's Restart on the Hub page waits through the hub data load.

**A POST board that cannot land no longer ends a tap.** `send` (app.js) waits for a board made after the tap when a reload won the race (shared race R1).

Audited and left on `waitOn`: Review answer, Lineup move, Triage, new task and ask buttons end on `B.send`'s own board, drawn in the task the request resolves in.
