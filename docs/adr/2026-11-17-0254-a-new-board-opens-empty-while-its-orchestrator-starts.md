# A new board opens empty while its orchestrator starts

This extends [a starting board shows its session's liveness, activity and prompt](2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md). Until now, a New board was only a Starting row in the sidebar until its session ran `kickflip join`. That join made the board's files, picked its port and put it in the manifest's `sites`, which is when the hub started its server. Before the join there was no page to open. The owner (T-572, T-574) asked for "Empty board, New open".

## The hub serves the board before the join

When the clone is ready, `new-board.mjs serveStart` gives the Starting record a `site` of `{dir, port, cmd}`. The site's files go in `sites/<route>`, the same files `kickflip board` makes (`board-site.mjs boardFiles`), and it gets a free port (`board-site.mjs freePort`, which skips the ports that starting sites hold). For an existing clone, that happens after its fetch. The site goes on the record, not in `sites`, so the hub's loops for joined boards stay as they are. Waking the session, listening, links, the router and the sidebar's board rows still see only joined boards. Three places read `boards.mjs servedSites`, which is the joined sites plus each starting site whose route has none yet:

- the supervisor's reconcile, which runs the server;
- the proxy and upgrade paths, so `/<route>/` opens the board;
- the hub stream's targets, so the open page follows the board's changes.

A Retry keeps the record's site, so it serves the same board again. Dismiss removes the record, the reconcile stops the server, and the site's folder is deleted along with any asks filed there.

## The join takes it over

`kickflip join --template board` for a route with no site uses the Starting record's site dir and port, provided the record names this session or no session. `boardFiles` then writes the same board.json and keeps the existing item file. The new `sites` entry has the same cmd, folder and port as before, so the supervisor's key doesn't change and the same server keeps running (`starting-served.test.mjs`).

## What the board shows

- **Banner.** While the session hasn't joined, the board view's start banner (`ui-sidebar.js startBanner`, drawn by `app-banner.js renderStart` from the sidebar's starting entry) reads "orchestrator starting". It shows the start's bars and caption, plus the prompt the session waits on (Allow / Deny) or a stalled start's Retry. A failed or ended start reads "orchestrator didn't start" with why it failed and Retry. The banner is orange while the board starts, and red while a prompt waits on the owner or the start has failed. It goes once the session joins.
- **Header.** The board server reads `listen` as `starting` when its folder is a starting site (`boards.mjs startingAt`). Its watcher check is then `starting`, not `stopped`, so the header doesn't say "Claude not listening".
- **New.** New is open. An ask is filed as a card as before (`server.mjs fileNewAsks`). While the board is starting, each New ask that is waiting reads "waiting for the orchestrator" (`domain.mjs withHub` state `starting`, `ui-cards.js askLine`). It waits in New until the orchestrator joins and triages it.
- **Sidebar.** Once a Starting row's board is served, its title links to the board.
