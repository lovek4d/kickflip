# The hub restarts itself from its stale-code notice

The owner asked on #146: "I think the hub needs a restart is kind of broken. Please audit that. … it just scrolls down, but it doesn't seem to scroll to anything in particular. I figure maybe it should just have a confirmation or something."

- **The audit.** While the hub ran older code than its files, the Hub row's Degraded word jumped to `#integrations`, the Integrations heading, as for a failing link; nothing there restarts the hub, and the row only named the `launchctl kickstart` command to run by hand.
- **Restart hub.** While `hubView`'s `hub.restart` is true (the hub's running code hash differs from its files', the same test as `boards.mjs` `hubLink`), the Hub row carries Restart hub, and the status word jumps to that button and focuses it. Otherwise it still jumps to Integrations.
- **The route.** `POST /_hub/restart-hub` (application/json, same-origin, so any viewer of the hub may, as for `/_hub/restart-board` in [a board restarts from its row on the Hub page](2026-11-02-1736-a-board-restarts-from-its-row-on-the-hub-page.md)) answers `{restarting: true, command}` and, once that answer is flushed, runs `board/worktree.mjs` `restartRunner('hub')`: the hub service's restart (`shared/service.mjs`), which replaces the process, or `KICKFLIP_RESTART_CMD` in tests. A second tap while one is out gets 409.
- **The page waits for the server.** The button reads restarting… from the confirmed tap; a refusal shows its error and brings the button back. After the answer, the page asks `/_hub/api/hub` each second until it answers with an `x-hub-code` other than the one the restart's answer carried, then reloads the app (`AppShell.reload`). After two minutes it says the hub hasn't come back and names `command` to run on the host.
- **The confirm is the browser's own** (`BoardDialogs.confirm`, [confirmations are the browser's own](2026-11-03-0259-confirmations-are-the-browsers-own.md)), like a board's Restart. The card's notes asked for an in-page sheet; [confirmations are the browser's own](2026-11-03-0259-confirmations-are-the-browsers-own.md) retired the page's sheet at the owner's word ("we should never ever make a fake native confirmation"), so this follows it.

Considered:
- answering only after the restart: the restart stops the process that would answer;
- reloading on the first answer after an outage: a fast restart can come back between two asks, and the old hub can answer before it stops, so the page waits for the code hash to change instead.
