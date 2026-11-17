# Cards, questions, asks and settings leave store.mjs for their own modules

The split of store.mjs by concept behind files.mjs (T-596 architecture review, finding 5) ends here (T-647). Slack and
the data migrations left first
([Slack and the data migrations leave store.mjs](2026-11-17-2300-slack-and-migrations-leave-store-mjs-for-their-own-modules.md));
the rest of store.mjs goes now, one module per concept:

- `board/checks.mjs`: `BoardError` and the checks every command makes on what it is given (`needSite`, `text`, `domId`,
  `cardTitle`, `pageUrl`, …).
- `board/cards.mjs`: item files and each card in them, its thread (status lines, messages, uploads, reads, pushes),
  lane, deps, links and PRs, the one write that changes a card (`setItem`) and the one that adds one (`addItem`),
  merges and the Done archive. A card's name and the card an ask became (`cardName`, `askCardOf`) are card reads.
- `board/questions.mjs`: questions and notes: owner.json, staging and screening, gates, answers and resolution, the
  prototype takes, the notes file, and the planner work around them (staging, discussing, briefs, grill rounds).
- `board/asks.mjs`: filing, titling, answering, relating, triaging, moving and handing off asks, a board's asks to
  other boards, replies to events (`writeReply`), and the session's reviews of incoming PRs.
- `board/settings.mjs`: board.json's settings, pause, description, reviewers, rules and share, the setup handshake,
  and the board's own manifest entry (`boardTarget`, `boardRepoOf`).
- The run records (agents/<id>.json: `startBuilder`, `startTappedBuild`, `startPlanner`, `closeRecord`,
  `stopPlanner`, `landable`, the builder's progress, calls, asks and done) join `board/runs.mjs`, so a run's record
  and its launch are one module, as [a board-launched run lives in one runs module](2026-11-17-2345-a-board-launched-run-lives-in-one-runs-module.md)
  meant to end with.

store.mjs keeps no code: it re-exports each concept's functions, as it exported them before, for `board.mjs` and the
tests. Every other module imports from the concept modules, slack-store.mjs and migrations.mjs included, so store.mjs
drops the helpers it exported for those two alone (`ownerFile`, `ticketWrite`, `archiveWrite`, `boardTarget`, …), and
it imports slack-store.mjs no more. `store-split.test.mjs` holds each of these.

## What the split does not do

- The concept modules import each other. A card's write moves its questions, asks and runs (`setItem` closes its
  questions, files its ask, pauses its build), and those write cards back, so they import from each other, functions
  only: no module's top-level code reads another's export as it loads, which is all an ES module cycle needs. A
  layering with no cycles would mean taking those decisions apart, which is a design change, not a move. Slack is in
  the ring the same way: `writeReply` queues a reply for its Slack thread (asks.mjs → slack-store.mjs), and the Slack
  commands file and answer cards (slack-store.mjs → cards.mjs).
- Each module imports the hub modules it calls (boards, routes, locks, usage gate, …) as store.mjs did; only the board's
  data files go through files.mjs.
- Callers that use store.mjs as one namespace (`board.mjs`, the stop hook, the CLI's lazy imports, the tests) keep
  using it, through the re-exports.
