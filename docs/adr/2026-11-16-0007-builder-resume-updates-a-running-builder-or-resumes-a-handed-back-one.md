# Builder resume updates a running builder or resumes a handed-back one

Status: accepted, 2026-11-16 (#804)

## Context

On T-462 the owner's note "Separate from the page" reached the card after its builder had started. Nothing carried it
to the builder, which built the rejected design and handed back. The orchestrator then had no way to send the build
back: the board launches a builder only when it pulls a ready card, and redoing the work itself with an Agent was
refused. A builder could ask the orchestrator mid-build (`builder ask`), but nothing flowed the other way.

A first shape added a `send-back` command and a "Sent back" state. The owner asked why it wasn't simply resuming the
builder, which the board already does: `headless.mjs resumeBuilder` resumes a builder's own session with a why for a
land conflict and for a cleared pause.

## Decision

**News.** Words that reach a card In Progress for its builder after its build started are news: the orchestrator's
`builder resume`, the owner's thread message (server.mjs, on the item-message), and a notes section `item notes` adds.
News waits on the card's main build record, running or handed back, as `news [{at, from, text}]`, and leaves it as it
reaches the builder:

- A running builder gets it as "New on <key> while you build: …" in the reply to its next command (progress, call, ask,
  and `builder asks --wait`, which returns early for it as for a pause), after its next tool call through the
  PostToolUse hook (`hooks-plugin/hooks/board-messages.mjs`, which finds the card by the pointer
  `data/builder-news/<session id>.json`), or in the refusal of its `builder done`, which refuses while news waits so the
  builder takes it in before handing back.
- A handed-back build keeps it for its resume.

**Builder resume.** `builder resume <key> --text <t>` is the orchestrator's. On a running build the text is news, with
the thread line "Passed to the builder: <t>". On a handed-back build it is news too, and the record is marked
`rerun {at, text}`; the board server's auto pass (which a record write triggers) opens the record again, clears the
card's Next, writes "Resumed: <t>", and resumes the builder's own session through `resumeBuilder` with `rerunBrief`:
the news since the hand-back, the orchestrator's text last. The card reads building again, and the builder's calls,
still unverified, come back with its next hand-back. There is no "sent back" state.

The resume needs a Claude session the board launched: a session's own builder or a Codex build is refused, since a
fresh launch would start from the card's brief without the words.

## Consequences

- The orchestrator never redoes a build itself: a wrong build goes back to its builder.
- News that reached the builder during its run isn't repeated in a resume's brief: its own session read it.
- An owner message on a handed-back card waits for a resume; if the orchestrator verifies the build instead, the news
  stays on the closed record unread, and the owner's message reached the orchestrator as before.
