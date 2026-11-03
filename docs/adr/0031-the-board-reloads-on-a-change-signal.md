---
status: superseded in part by ADR-0055
---

# The board reloads on a change signal

Superseded in part by [0055](0055-one-app-for-the-whole-hub.md): in the app shell the page holds the hub's one stream, `/_hub/stream`, which passes each board's signal on as `change {route}`, in place of a stream per board. The server side, the 30-second poll and the header's time below still hold.

Each board page holds one server-sent event stream, `GET /api/stream` in `board/server.mjs`, and reloads the board and its open cards' threads as soon as the stream sends a change signal (owner ask, card INT-68).

- **The server** watches, with `fs.watch` on each folder of each tree ([0159](0159-the-board-watches-each-folder.md)), the wave files' folder (`~/.claude/waves`, or a board's own items file's folder) and the site's `data/` (`watchBoard` in `board/server.mjs`). A burst of writes sends one `event: change` after 100 ms of quiet, and a steady run of writes still sends one every 500 ms. A folder that doesn't exist yet is watched once it appears, with one signal then. The stream is written straight to the socket, never gzipped ([0028](0028-the-board-opens-on-the-last-visit.md)), and carries a comment every 25 s so nothing between the phone and the Mac idles it out.
- **The hub** pipes the stream through unbuffered. When the page leaves, it closes the site's end, and when the site dies mid-stream, it ends the page's end, so the page reconnects instead of waiting on a dead stream.
- **The page** (`board/public/app.js`) opens the stream through `ClaudeSite.url`. The browser retries a dropped stream by itself. A stream the browser gave up on, such as after the hub's 502 while a site restarts, reopens after 1 s, doubling up to 30 s. A reopened stream reloads once, since signals may have been missed. A signal while the page is hidden waits for it to show.
- **The 30 s poll stays** as the fallback for a missed signal and as the offline check: a failed poll, or any failed board load, turns the ↻ and time red ([0021](0021-the-board-shows-github-checks-and-watcher-health.md)). A lost stream with working polls isn't offline.
- **The header's time** is the time since the page last got a change signal or a manual refresh, whichever is newer (`nextFresh` in `board/public/ui-header.js`). A ↻ tap always sets it. A signal sets it only when the board or an open thread its reload brought differs from what the time last counted, ignoring `generatedAt`, so a write that changes nothing the page shows, such as an upload alone, leaves the time as it was. A poll never sets it. The first board load that lands sets it; until then the last visit's snapshot shows its own saved time, in the same place and style. Its tooltip reads "Updated 3 min ago: the last change from the Mac, or your last refresh".

The header showed when Claude last wrote, and the board changed only on the 30 s poll. A refresh reloaded the board but left the time at "2 min", so it read as broken, and a reply took up to 30 s to appear. Through the hub and Tailscale, a signal reaches the page about 0.4 s after a thread write starts.

Considered:
- polling faster, which costs the phone's battery and still lags;
- a WebSocket, which the hub already pipes, but which needs a handshake and framing for a one-way signal;
- a push to the phone, which would reach the lock screen ([0006](0006-pushes-only-when-something-waits-on-the-owner.md));
- moving the time on every signal, including ones that changed nothing the page shows.
