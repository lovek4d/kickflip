# A limit a person sees stays, and its test passes the runner

Some product time limits guard something a person would see, so they stay, and the code takes what they limit, so a test passes its own and no load can trip the limit there (docs/test-determinism-audit.md, F9):

- **Session id wait, 15 s** (board/agents.mjs `launchAgent`). A launch goes on without the session id rather than stall a pull on an agent that stays silent. `sessionWait` sets it; agents.test passes `Infinity` where it reads the id, and `0` to test the give-up.
- **Reviewers' lookups, 12 s each** (board/reviewer-people.mjs). Board settings' Reviewers answers before the hub's proxy gives up on the board, which the page reads as a restart. `reviewerPeople` takes the Slack and GitHub lookups and a `giveUp(what)`, so its tests give up by hand; the board server passes the real lookups, and server.test sets `KICKFLIP_PEOPLE_WAIT_MS` past the run's own limit.
- **Status line git, 500 ms per call** (bin/statusline.mjs). A slow repo drops the branch rather than hold up Claude Code's redraw. `statusLine(input, {git})` is exported; statusline.test passes a git with no limit instead of retrying the script five times.

Nothing changes in shipped behaviour for these.
