# A builder records its judgment calls and the session verifies them before land

The builder grills the session, not the other way round (#34). It asks about gaps in its brief before building, records each judgment call as it makes it, and the session checks those calls against the owner's words and the other cards before the card lands. Land waits on the session's check only, never on the owner.

**A call is a line on the builder record.** `board.mjs builder call <key> "<call>"` appends `{at, text}` to the agent's open record's `calls`, one plain line each, and refuses with no open record. `builder calls <key>` prints them numbered, then "verified <time>" or "not verified yet". The thread shows a record's calls as one collapsed entry under its agent lines, at its finish, or at its newest call while it runs (`board/domain.mjs` `threadOf`, `board/public/ui-threads.js`); it counts as no message.

**Verified is one stamp per record.** `builder verified <key> [--note]` sets the record's `verified {at, note}`, covering every call made before it; a later call needs a new stamp. It works on a closed record, since the hand-back closes it, and refuses when nothing is unverified. `land` refuses while any record on the card, of any agent, has a call after its stamp, naming `builder calls` and `builder verified` with each agent; a card with no calls lands as before (`board/store.mjs` `checkCallsVerified`).

**Questions stop the builder.** A background agent can't take a message mid-run, and SendMessage resumes one that stopped. So right after `builder start` the builder records each gap as a `Question: …` call and, with any, hands back with `item set --status checking --next "Answer the builder's questions"` and stops. The session answers from the card's notes and thread, asking the owner on the card only what those don't settle, and resumes it with SendMessage.

**A start on unverified calls resumes the build.** `builder start` on a record whose calls aren't all verified keeps its calls, any stamp and its worktree, so the resumed builder's `builder start` loses neither its questions nor the record `land` reads. Once verified, a start is a new build with no calls.

**The session lands a card with calls.** A builder that recorded calls doesn't land: it hands back with `item set --status checking --next "Verify the builder's judgment calls"`, listing them. The session checks each, sends a conflict with the owner's words to the owner as a question on the card and any other wrong call back to the builder, runs `builder verified`, then lands. A builder with no calls lands its own card as [the board records what it knows, and commands make the rule calls](2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md) has it.

The owner, on #34: "the builder grills the orchestrator up front on any gaps in the plan it was given or any ambiguity and then collects judgment calls throughout implementation and then verifies those with the orchestrator at the end", and "it would be better if we have the builder collect those judgment calls during implementation so it doesn't have to recall as much."

Considered:
- the builder waiting for answers in the thread: a background agent would have to poll, where stopping and SendMessage need nothing new;
- the builder landing after the session verifies: a second resume for every card with calls, where the session can run `land` itself;
- checking only the latest build record: a second agent's calls on the same card would slip past `land`;
- `item set --status done` checking calls too: a card closed without `land` was closed by the session, which is the one verifying.

Superseded in part by [a card stores its lane, and facts replace statuses](2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): builder done with unverified calls closes the record with handed_back and the Next; there is no checking status.
