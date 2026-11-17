# Slack and the data migrations leave store.mjs for their own modules

store.mjs was many modules behind one file: a few hundred lines of file core and some 6,000 lines of concerns that share
only that core, behind one interface of 274 exports (T-596 architecture review, finding 5; the owner took option A,
split by concept behind the files core). The core went to `board/files.mjs` first
([every process writes a board's data through one files module](2026-11-17-0521-every-process-writes-site-data-through-one-files-module.md)).
The split moves one concept per task, Slack and the migrations first, since their callers were already elsewhere: the
hub's Slack sends and the starts of the hub and the board server.

- `board/slack-store.mjs` holds Slack from the board's side: each PR's link and its reactions (`data/pr-slack.json`),
  each reviewer's day thread and digest (`data/review-digests.json`), the Slack threads a board's tasks were filed from
  (`data/slack-threads.json`), and the orchestrator's `slack` commands. `hub/review-send.mjs` and
  `hub/slack-intake.mjs` take their Slack functions from it, so the hub imports store.mjs for Slack no more. A change
  to Slack replies opens this module alone.
- `board/migrations.mjs` holds the data migrations: the board server's start-up passes (follow-ups, statuses, phases,
  gates, created, discussing, staging, dead fields) and the hub's two manifest-wide ones (`migrateWaveNames`,
  `migrateDropWaves`). The ledger that runs each migration once (T-628) is built in this module.

Each writes its files through `files.mjs`. Until the cards concept leaves store.mjs too, each also imports the card,
question, archive and settings functions it calls from store.mjs, which exports those it shares with them (`askCardOf`,
`ticketWrite`, `archiveWrite`, the `needSite`/`text`/`domId` checks and the like). A reply's queueing for its Slack
thread (`writeReply`) makes store.mjs import `queueSlackReply` and `slackSourced` back, an import cycle of functions
only, which no top-level code of either module reads as it loads. The cycle goes when `writeReply` leaves with the
cards.

The rest of store.mjs stays as it was: asks and intake, PR review, settings and rules, prototypes, questions and
notes, cards, the Done archive and the agent runs. `fallBackFromLinear` stays with settings: it runs again whenever
Hub loses its Linear key, so it is not a one-time migration. `board.mjs` stays the only CLI, so
[agents write site data only through board.mjs](2026-10-29-1639-agents-write-site-data-only-through-board-mjs.md)
holds.
