# A joined board's prompts show on the board

#931 (T-573). The owner, on the prototype `board-prompt-joined`: "Strip across the top … align with the existing banner style for things like usage pause. this should go right under usage pause in terms of priority", and on whether the hub page keeps listing a joined board's prompts: "No, board prompts leave the hub page."

A pending prompt of a board's owner session (a record with a route, `hub/prompts.mjs`) shows on that board, not on the hub page.

- **The strip.** `#promptStrip` sits right under `#pauseBanner` (`app.js` markup), one row a prompt in the pause banner's red shape (`hold-banner ub-banner ub-going`, `ui-prompts.js` `promptStrip`): "Orchestrator waits on you · <tool>: <what>" with Allow once, Always and Deny. Red by AGENTS.md's colour priority: the session is held until the owner answers. Only the board's owner session has a prompt with a route, and its questions never become prompts: the ask gate sends them to the board as questions ([a headless board session asks on the board](2026-11-14-0646-a-headless-board-session-asks-on-the-board.md)), so the strip draws permission prompts only.
- **Answering.** The taps are `prompts.js` `PromptAnswers`, as on the hub page, Always confirming with its rule first. An answered row fades out, its buttons disabled, until the board's next copy drops it (`app-header.js`).
- **Data.** The board server already read its route's pending prompts (`pendingFor`) into `domain.mjs` `withHub`, which leads Needs you with them; `withHub` now returns them as the board's `prompts` too, which ride the board's sync like its other fields. A prompt's change signals the board (`hub.mjs` `promptChanged`).
- **The hub page** lists only prompts of sessions that own no board (`pendingFor(null)`), so its lines no longer name a board. A starting board's session owns no board yet, so its prompt still shows there and on its sidebar row and start banner.
- **The push** opens the board (`/<route>/`) for a board session's prompt, else the hub page (`pushOf`).
- **One set of buttons.** A starting board's row and start banner say Allow once, Always and Deny too, Always confirming first.

Supersedes in part [the board has no Needs you deck or pane](2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md) (its Pending prompts point) and [a background session's prompts come to the phone](2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md) (where a board session's prompt is answered and where its push opens).
