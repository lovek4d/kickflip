# The browser's polls ride the change stream

The owner, on T-385's Prototypes list poll: "Would like to audit this polling later" (T-422). Every board server already signals a change to anything it reads under its `data/` and item folders ([the board reloads on a change signal](2026-10-29-1639-the-board-reloads-on-a-change-signal.md)), and its minute pass signals any write the watch dropped and any clock-driven change, such as a GitHub check giving up ([the minute pass signals a write the file watch dropped](2026-11-15-0010-the-minute-pass-signals-a-write-the-file-watch-dropped.md)). The app shell holds the hub's one stream that passes those on as `change {route}` ([one app for the whole hub](2026-10-29-2005-one-app-for-the-whole-hub.md)). A browser poll of state that already rides that stream only repeats it.

So a view reads on its board's change signal instead of on a timer, and the shell hands each view `signal(fn)` and `streaming()`, true while the stream is open. A fallback check that stays runs only while the stream is down, so it is still the offline check when the host can't be reached. A process state with no write behind it keeps its poll.

## Every timer in the browser, and its verdict

Repaints that read nothing from the host, such as the header's "3 min" and the start steps' seconds, are local clocks and stay. They aren't polls.

| Where | What it fetches | How often | Hidden | Verdict |
|---|---|---|---|---|
| `app.js` board check | `api/board?since=` (304 when unchanged) | 30 s | rests | **Moved.** Runs only while the shell's stream is down. The change signal, the stream's reopen and the server's minute pass cover what it caught. |
| `app-asks.js` asks watch (`ClaudeSite.watch`) | `_claude/events?kind=ask&limit=50` | 10 s while any of those asks has no reply, else 60 s | runs | **Moved, deleted.** It only reloaded the board, and the events and replies it watched are in `data/`, whose writes already signal. `B.watch` went with it. |
| `app-header.js` pending GitHub check | `api/board` | 5 s while a ↻ check is pending | rests | **Moved, deleted.** The check lands as a write in `data/`, and the minute pass signals the 5-minute give-up. |
| `view-questions.js`, Waiting on you on its own page | `api/board?since=` | 15 s | rests | **Moved.** Reloads on its board's change signal. The 15 s check runs only while the stream is down. In the desktop pane it was already the board's. |
| `view-settings.js` rules replies (`ClaudeSite.watch`) | `_claude/events?kind=rules` | 10 s while a rules change waits for its reply, else 60 s | runs | **Moved.** Read on open and on each change signal, since a reply is a file in `data/replies/`. |
| `prototype-kit.js` served viewer | `api/try/prototypes` | 1.5 s while the site starts, 3 s once it's up, the whole time the page is open | runs | **Moved.** hub/try.mjs records each step of the serve in the board's `data/try.json`, and the start log is `data/try/prototypes.log`, so every state the page shows is a write the board signals. The page opens the hub's stream itself, since it is its own document, and reads on its board's `change` and when a dropped stream reopens. The running step's seconds count up locally. One read runs at a time. |
| `view-settings.js` read-only retry | `api/settings` | 5 s | runs | **Kept.** Only while the board can't be reached and the page shows its saved copy. A board server that's down sends nothing. |
| `app.js` down landing retry | `api/board` | 5 s | rests | **Kept.** Only while the board can't be reached. The stream may be down with it. |
| `hub-kit.js` `live`: the Hub page (`/_hub/api/hub`) and hub settings (`/_hub/api/settings`) | that JSON | 30 s | rests | **Kept.** Hub state such as integrations' link health, usage and sessions without a board has no write a board signals. An event would have the hub rebuild the Hub page's data on a timer while any page listens, Hub page open or not, which is the same poll moved to the host. |
| `app-reader.js` log reader | `api/transcript?from=` | 3 s while the open log isn't finished | runs | **Kept.** Logs live in `~/.claude/kickflip/logs`, outside every board's watch. A watch there would fire on every builder's line on every board. It runs only while the reader sheet shows a running log. |
| `log.html` | `api/log` | 3 s | runs | **Kept**, for the same reason, on its own page. |
| Restart waits: `sidebar.js` restart row, `view-hub.js` Restart hub | `/_hub/sidebar.json`, `/_hub/api/hub` | 1 s, up to 120 tries | runs | **Kept.** Only after a Restart tap, while the server it waits for is down and sends nothing. |
| `shell.js` stream reopen | `/_hub/stream` | 1 s doubling to 30 s | runs | **Kept.** The stream itself. |
| `ui.js` `fetchJSON` retry | the load it retries | backoff | runs | **Kept.** Retries of one failed load, not a poll. |

## Before and after

Requests per minute from one idle open board in headless Chrome, against a scratch hub and board run from this tree (a throwaway script on `shared/chrome.mjs` and `hub/hub-fixture.mjs`), counted for 180 s after a 20 s settle:

| | Before | After |
|---|---|---|
| Idle board | 3.7: `api/board` 2.3, asks watch 1.0, `needs.json` 0.3 | 0.7: one change's `api/board` and `needs.json` |
| One ask waiting for its reply | 8.7: asks watch 6.0, `api/board` 2.3, `needs.json` 0.3 | 0.7 |

Provisional: taken while the host was busy, with load averages of about 20 before and 6 after. The counts don't depend on load, but the host was not idle. By the code, an open served prototype page read 20 to 40 times a minute and now reads once per board change. That page wasn't measured.

## What changed

- A board server going down while the hub stays up no longer turns the board's header red within 30 s, since the hub's stream stays open. A tap still fails with its toast, the hub restarts a server that stops answering ([the hub restarts a session not listening and a server not answering](2026-11-15-0123-the-hub-restarts-a-session-not-listening-and-a-server-not-answering.md)), and the board reloads on the change the hub sends when that server's stream comes back.
- A view outside the shell has no `streaming`, so its checks run as before.

Supersedes in part [the board reloads on a change signal](2026-10-29-1639-the-board-reloads-on-a-change-signal.md), whose 30 s poll ran always, and [a base move restarts the prototype serve](2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md), whose viewer polled.
