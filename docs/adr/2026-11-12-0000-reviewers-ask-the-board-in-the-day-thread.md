# Reviewers ask the board in the day thread

Status: accepted (#531, 11/11). Builds on [review posts go into one day thread per board](2026-11-11-1600-review-posts-go-into-one-day-thread-per-board.md).

Superseded in part by [a day thread carries only each PR's link](2026-11-12-0044-a-day-thread-carries-only-each-prs-link.md): orchestrator messages are at most 250 characters, and it writes in the thread only when asked.

## Context

The owner's pivot on #505 (11/09) made each board's day thread "effectively ... general messages to that board's orchestrator, allowing reviewers to ask the board broader questions, not stored anywhere but the slack thread". #522 put the review posts in that thread; this card makes the board hear it.

The owner's answers:
- #505 (11/10): poll `conversations.replies` on each hub poll; answer only, and a request for work becomes an ask to the owner; "🤖 " before each answer. On the PR chatter: "make sure the users cannot ask for quick build implementation, only answers to questions, or new tasks that file as a grill ticket for me to review (with the slack message in the kickflip thread)".
- #531 (11/11): one command files a work request, grilling only. The owner's own messages reach the orchestrator too, "filter mine by @kickflip? else they still reach orchestrator but does not expect a reply". A thread is heard for 7 days. The orchestrator tells reviewers only about this board. Until the app is reinstalled with im:history: one push and a line on the Slack row, and sends go on.

## Decision

**The hub hears each day thread for 7 days, the day it opens included.** `data/review-digests.json` keeps the entries of those days, not only today's. Each entry gains `heard`, the ts of the newest message the hub has read in it: a cursor, no text. On each poll, after the sends, `hub/review-send.mjs` reads `conversations.history` once per reviewer DM, since boards share one DM per reviewer, and `conversations.replies` only for a thread whose `latest_reply` is past `heard`.

**Each new message wakes its board once** with `slack-question {reviewer, channel, thread_ts, ts, from, answer}`, appended with `hub/boards.mjs appendEvent`. The event says where the message is, never its words. `from` is `reviewer` or `owner`. The token posts as the owner, so a message from the owner's user is the board's own when its ts is one the board recorded (links, bumps, openers, digest replies), or when it opens with "🤖 ". Those wake nobody. `answer` is true for a reviewer's message and for an owner's message that names @kickflip (the literal text, any case). The app has only a user token and no bot user, so there is no app mention to look for.

**The orchestrator reads, answers or files, through `board.mjs` and Hub's token:**
- `slack thread <event>` prints the thread, naming each message board, you or the reviewer.
- `slack answer <event> --text` posts "🤖 " and the answer, at most 600 characters, so it stays brief. It refuses an owner's message with `answer: false`.
- `slack task <event> <file> --title (--notes | --notes-from)` files a new card grilling, never ready, so a reviewer can never get a Quick build. The Slack message is the card's first thread line, under its writer's name, `via: slack`, linking to the message when the Slack identity has the workspace domain. The grill and its prototype gate are the owner's review.

Answers stay only in Slack. SKILL.md tells the orchestrator to speak only about this board's cards, PRs and code.

**Until the token can read DMs**, the manifest asks for `im:history` and Slack answers the reads `missing_scope`. The hub records `unheard_at` with the token in `secrets.json` and pushes once (a fault). The Integrations Slack row stays ready and adds a line saying what to do. Sends go on. The first read that works clears it, and so does saving a new token.

## Rejected

- **One event per thread per poll.** Rejected: the owner's and the reviewer's messages in one poll call for different handling (an answer or none).
- **A cursor from the newest ts seen per DM.** Rejected: boards share the DM, and each board's cursor belongs with its own thread record.
- **Refusing `slack task` on the owner's messages.** Rejected: the command only ever files grilling, which is the safe path whoever asks.
