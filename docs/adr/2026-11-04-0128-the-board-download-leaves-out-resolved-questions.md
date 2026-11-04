# The board download leaves out resolved questions, and an unchanged reload downloads nothing

`GET /api/board` had grown to about 1.5 MB raw and 300 KB gzipped. Resolved owner questions made up half of the raw body and 70% of the gzipped one, and no first paint uses them. Each owner tap also downloaded the board twice: once in the events POST's answer, and again when the tap's own file write sent a change signal. This changes three things. Done cards stay as they are, because #190 decides what card data is kept.

- **Resolved questions load when a topic shows (owner, gh103-resolved).** `/api/board` (server.mjs `pageBoard`) leaves out every question whose state is resolved. `ownerTopics` still lists every question id and counts them, `resolved` included. The server builds the full board first, so `threadOf`, `archOf`, pushes and card counts see every question as before. `GET /api/questions?topic=<id>` returns one topic's resolved questions, in the same shape `owner` uses. Waiting on you (view-questions.js) fetches them for the topic it shows, whether the topic is resolved or open with some resolved questions in its "Resolved · N" fold. It fetches again when that topic's resolved count changes. A prototype page for a resolved question (prototype-switcher.js) gets it from its topic in the same way, so a pick can still change.
- **The board carries a version (owner, gh103-unchanged).** `version` is a hash of everything in the board except `generatedAt`, so two boards with the same content have the same version. `/api/board` sends it as a weak ETag. A request whose `If-None-Match` names it gets a 304 with no body. The page sends that header itself, keeping `cache: 'no-store'`, because the browser's HTTP cache doesn't see the board an events POST answers with. app.js sends the version of the board on screen, and only while the view is fresh. ui-snapshot.js drops `version` from the last-visit snapshot, since a snapshot is a trimmed board, so the first load after a snapshot paint always downloads. Waiting on you's 15 s poll goes through `fetchJSON({tag})` the same way.
- **A tap is one download (owner, gh103-tapanswer).** Every events POST answers with `pageBoard`, which includes the version and the request's `onHost`. The page already draws from that board. The change signal the tap's own write causes still reloads, but the reload names the POST board's version, so it gets a 304 unless something else changed. Waiting on you's Send and prototype eye now draw from their POST's board too, instead of reloading.

Measured on a copy of hub-orchestrator's data (not the live server), served by this code with the hub cut off:

| | Raw | Gzipped |
|---|---|---|
| Before | 1,516,054 | 308,109 |
| After | 757,114 | 102,431 |
| Unchanged reload | 0 (304) | 0 (304) |

A resolved topic's `/api/questions` answer is under 1 KB gzipped.

**The version depends on data only.** `holdChoices` sends each chip's length (`ms`, or null for Forever) and no "until 2:26am" words. ui-cards.js `holdPicker` writes the end time for the moment the Hold sheet opens, so the sheet stays current while the board's version doesn't change with the clock (owner, on #103's check). The board carries no other wording based on the clock. A time threshold, such as a builder reading stalled once it has been silent long enough, changes the version once, when the card's state actually changes. On the data copy, ten minutes with no data change kept the same version.

Considered:
- the browser's own revalidation (`cache: 'no-cache'` with a `no-cache` response): a tap's POST board never enters the HTTP cache, so a 304 could restore an older cached board under its older `generatedAt`, and `land()` would then refuse it;
- skipping the next change signal after a tap: whether a signal came from this tap depends on timing, and a skipped signal could hide another session's write;
- leaving resolved questions out only for resolved topics: an open topic's "Resolved · N" fold would still carry every resolved question.

Follow-up filed: per-card patches instead of downloading the whole board again.
