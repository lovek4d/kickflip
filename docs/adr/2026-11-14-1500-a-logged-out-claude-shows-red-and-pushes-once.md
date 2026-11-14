# A logged-out Claude shows red and pushes once

On 11/13 the hub board's Claude Code session sat at a login prompt for over an hour and the board showed only "waiting on you". A logged-out Claude is a fault that needs the owner now, so it is red (AGENTS.md colour priority).

- **Detection.** After each session check the hub (`hub/logged-out.mjs`) reads the hub board's tmux pane (`tmux capture-pane -p`) and the logs of headless runs written in the last 10 minutes (a final `result` event that is an error). Either matching `LOGIN_TEXT` opens an episode.
- **Strings.** `LOGIN_TEXT` (Please run /login, Not logged in, Invalid API key, OAuth token has expired, authentication_error, Failed to authenticate) comes from known Claude Code messages, not a capture from a real logged-out session. Widen it when one is captured.
- **Show.** An open episode for a board makes its sidebar row red, "logged out: run /login" (`siteStatus`, listen `logged-out`), ahead of the listen state. No banner and no sheet (owner, q-t288-look).
- **Push.** One push per episode, "Claude is logged out: run /login", tapping it opens the board; none on clearing. `logged-out-state.json` holds the open episodes and clears when the text is gone.
- **Headless runs.** Log files carry no board, so an episode from them is keyed `headless`: it pushes once and opens the hub, but marks no board row.
