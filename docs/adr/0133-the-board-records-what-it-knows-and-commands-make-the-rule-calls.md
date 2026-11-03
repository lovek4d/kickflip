# The board records what it knows, and commands make the rule calls

A fact the board server, the watcher or the hub already holds is written by them, not by the session. A decision SKILL.md states as a rule is a command's answer, not the session's. This extends [0131](0131-the-cli-and-board-server-do-the-boards-housekeeping.md); the session keeps the judgement calls.

- **Action needed pushes.** The board server pushes each card's Action needed itself (`board/domain.mjs` `ownerActions`), one tag per card (`item-<wave>/<id>`, `ask-<event id>`) and `topic-<id>` for a Needs you topic off the cards. A tag pushes when it appears, changes kind or gains an open question, and its queued push is dropped once it is gone. `data/action-pushes.json` keeps what waited at the last check, so a restart pushes nothing again; its first check records what already waits without pushing. Questions, picks, manual steps and an ask's Done go `--now`; Ready and Merge queue. `question add` and `question confirm` no longer push, and the `q-<id>` tags and the `push_tag` stamp go. A session pushes only a `fault`.
- **The last answer starts a card.** When an owner answer leaves an unstarted work card with no open question, nothing blocking or holding it and nothing else waiting on the owner (`startedByAnswer`), the board server appends `card-unblocked {key}`.
- **Building.** A build's `builder start` (`--kind build`, `codex` or `opus`) marks the card building, so the held, blocked-by and noted-pick refusals and the ticket move run there; it takes `--confirmed` for a noted pick. It prints `ref: <label>`, the card's name for its commit subject.
- **Landing.** A site card's builder lands its own card with `land`, which takes `~/.claude/kickflip/land.lock`: a second `land` while one runs refuses, naming the card, and a lock whose process is gone is taken over. `--status checking` is left for a builder that can't land.
- **Merging.** `board.mjs merge <key>` reads the PR, refuses with each reason GitHub wouldn't merge it (`mergeBlockers`, the rule the board's Merge button uses), refuses commits after the newest approval unless `--after-approval` says why they're trivial, and refuses a card with manual steps unless `--confirmed` quotes the owner. It then squashes and records the card merged. A refusal while the owner's Merge waits on the session writes why on the card.
- **Reviewer steps.** `board.mjs review due` lists the reviewer DMs, `git_merged` reactions and digest still owed, each with the command that records it once sent. It sends nothing. `reviewers add|remove|set` also write the list to each unfinished wave.
- **Small records.** `checked` with no flag records idle when no card has an open PR. The watcher answers a `hello` itself, and `hello-ack` goes. `arch file <key>` turns an architecture review's answered findings into cards and closes the audit once every finding is settled. An architecture review's audit card and `lineup` order lines use the board's ticket labels ([0132](0132-a-card-is-named-by-its-boards-ticket-source.md)).
- **Working marks.** The watcher Stop hook also blocks a turn once while a message on the session's board reads Working on it with no answer, reading the board server's `GET /api/working`. The 30-minute `reminder` event goes.

The audit behind hub/INT-209 found more of the same: built cards still reading planned, merged PRs never recorded, pushes under made-up tags and for news, reviewer lists copied by hand and merges by a remembered checklist. The owner picked each change above on hub/INT-271.

Considered:
- keeping question pushes in `question add` and adding other kinds there: every other Action needed still waited on the session to push;
- a push per question: the owner got dozens a day, where one per card replaces the last;
- the session landing after a `checking` hand-back: the card waited on the session for minutes, and the reminder only nagged;
- `merge` checking the rule and leaving `gh pr merge` to the session: the record could still be skipped;
- `review due` sending to Slack itself: kickflip holds no Slack token.
