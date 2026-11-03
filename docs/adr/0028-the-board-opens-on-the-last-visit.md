---
status: superseded in part by ADR-0096, ADR-0135
---

# The board opens on the last visit

Superseded in part by [0096](0096-colour-says-whos-waiting.md): a changed line flashes blue, news for the owner to see.
Superseded in part by [0135](0135-an-updated-card-takes-a-brief-tint.md): a changed card takes its own sign, not the flash round the card.

Each device keeps the last board page it showed, and the next visit paints it at first paint, dimmed, while the first load runs.

- **The snapshot** is the last `/api/board` this device rendered with the threads it holds, in `localStorage` under `boardSnapshot:<site root>`, since the hub serves every site from one origin. `board/public/ui-snapshot.js` packs it: open cards' threads first, then In Review, Stale, In Progress and Todo, then any other thread read on this device, capped at 900,000 characters by dropping threads past the cap. A board that alone passes the cap isn't stored. Every read and write is wrapped, so private mode or a full quota just means no snapshot. It is saved a second after each fresh board or thread load, and on `pagehide`.
- **While it shows** (`body[data-board="snapshot"]`), the page reads normally: scrolling, opening cards and reading threads work at any age. The controls that send to the Mac wait for the fresh board: the card action row, a thread's Send, quick reply and prototype eye, Plan a wave, an ask's bump, edit and delete, and the GitHub ↻. They turn on together when it lands. The + ask button works at once. The header looks exactly as it does after load: the same short time, the snapshot's saved time until the first load lands ([0031](0031-the-board-reloads-on-a-change-signal.md)), with refresh spinning, because the snapshot doesn't count as the first board load ([0021](0021-the-board-shows-github-checks-and-watcher-health.md)) (owner ask on INT-61). A phone that has never opened the board shows the empty header until the board lands.
- **The fresh board replaces it in place.** It rebuilds the same markup, so nothing moves unless the board changed, and when a card line, lane count, Needs you line or thread message reads differently, it flashes once: a builder-orange border that fades, around the whole card for a card line. If the Mac can't be reached, the snapshot stays dimmed under the offline note; the app shell itself then opens from the hub's service worker ([0055](0055-one-app-for-the-whole-hub.md)), so the last visit shows while the Mac is asleep.
- **Loads run side by side.** The app shell, `app.html`, starts the board and the open cards' threads in its `<head>`, before the scripts download, and `app.js` takes those loads over. Right after the first fresh board, threads for every In Review, Stale, In Progress and Todo card load in the background, so tapping one opens it filled. Done loads when tapped; a thread read on an earlier visit shows its saved copy at once while it updates. A thread already loading is never fetched twice.
- **The server compresses and caches.** `board/server.mjs` gzips every text response when the request accepts it, `/api/board` and `/api/thread` included. API JSON stays `no-store`. Each page names its relative scripts and stylesheets as `<file>?v=<mtime-size>`; a file asked for by its current version is `immutable` for a year, and pages and every other static file are `no-cache` with an ETag, so an edit reaches the phone on the next visit through the page.

On the owner's phone, about 0.13 s from the Mac, the board stayed blank until 0.4 s, every lane appeared at once at 0.8 s and an open card's thread at 0.96 s, pushing the cards below it down. The Mac builds the board in 0.03 s; the wait was the phone fetching the page, every script, the uncompressed 200 kB board and then each thread, one after another, every visit.

Considered:
- grey placeholder rows shaped like cards, filled lane by lane (question `int61-look`, option B);
- the Mac streaming the board in parts, most important first (option C);
- showing the snapshot only when under an hour old (question `int61-stale`, option B), or leaving it fully usable (option C);
- loading only open cards' threads (question `int61-threads`, option B), or every card's (option C);
- "Last visit · 11 h ago" in the header's time slot, built first and then removed so the header always looks the same (owner ask on INT-61).

The owner chose last visit first, read now and act when fresh, and preloading active cards' threads (owner, questions int61-look, int61-stale, int61-threads, option A).
