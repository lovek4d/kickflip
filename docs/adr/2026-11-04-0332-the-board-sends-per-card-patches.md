# The board sends per-card patches instead of the whole board on every change

Every change signal made an open board download `GET /api/board` whole, and every owner tap's POST answered with the whole board too. Since #103 an unchanged board answers 304, but any change, even one card's progress line, sent every card again. The owner asked for patches by work item: a card's data can be updated, removed, or moved to a new lane (#191).

- **A patch is per card, by key (owner, gh191-unit).** It carries each card that changed, whole, and the key of each card that's gone. When the cards' order changed, it also carries the new order of keys, so the page doesn't have to sort. Questions (`owner`) and topics (`ownerTopics`) are patched by id in the same way. Every other part of the board, such as `needs`, `checks`, `waves` or a setting, comes whole when it changed and is named in `unset` when it's gone (owner, gh191-other). `board/public/ui-patch.js` makes patches (`boardPatch`) and applies them (`applyPatch`). The server runs that file in a vm context, the same way `ui-order.js` runs, so both sides use one rule.
- **A card's question topic is named from its card (owner, gh191-other).** The owner wants questions and topics to refer to the work item's own id, with the pill text rendered from that card. A card's topic in the page's board now has `card: <key>` and no title, summary or askedAt of its own. `ui-questions.js` `cardTopics` fills those in from the card (`<ref>: <title>`, an ask's askedAt), so a card's rename patches only the card. A topic keeps its title when its card isn't on the page's board (an archived Done card), and so do declared topics and Other. Stored topic ids stay `item:<key>` in `owner.json`. Writers, pushes and the skill don't change, and no data has to move.
- **The signal stays a ping; the page asks for changes since its version (owner, gh191-transport).** app.js and Waiting on you call `GET /api/board?since=<version>` and still send `If-None-Match`, so an unchanged board still answers 304.
- **The server keeps its recent boards and diffs card by card (owner, gh191-fallback, gh191-diff).** `pageBoard` keeps the last 8 page boards it built (`BOARDS_KEPT`), by version. `answerBoard` diffs the board it builds now against the board kept for `since`. A version it doesn't keep, or no `since`, gets the whole board. The board is still built whole, as before, so cross-card fields (`blockedBy`, `order`, `sortAt`, `waveBands`, `needs`) and time-based changes (a stale lane, a stalled builder, GitHub's cached state) all appear in the diff, which patches emitted by the writers would miss. The version still covers the whole page board, `onHost` included, so a phone and the host's browser each diff against their own board.
- **A tap's answer is a patch (owner, gh191-tap).** `B.send` and Waiting on you's Send and eye put the page's version in the POST body as `since`. The server removes it before recording the event and answers with a patch from that version.
- **A patch from a board the page no longer shows is never applied over it.** A patch applies only to the board whose version it names. If another answer replaced that board while the patch was on its way, app.js drops the patch when it is older than the board shown, and otherwise reloads from the board shown. Waiting on you does the same after a tap, and otherwise waits for its next poll.

Measured on two reads of the live hub-orchestrator board, 35 s apart (that server runs the code from before this change, and the patch was computed from its two answers with `ui-patch.js`):

| | Raw | Gzipped |
|---|---|---|
| Whole board | 257,531 | 39,156 |
| Patch (1 card, `checks`) | 2,548 | 1,121 |

Notes, Board Settings and the prototype switcher still read the whole board once when they open. The last-visit snapshot and the first load of a mount (app.html's `BoardBoot`) read it whole too.

Considered:
- patches the writers emit for each change: they would miss changes that come from other cards and from the clock (above);
- a separate topic object for each card: it repeats the card's title in a second place, so a rename would change two records;
- a sync engine in the style of Linear's (a hydrated baseline, sync events per topic, versions as pointers): filed as follow-up #204, to be grilled with a research write-up first.
