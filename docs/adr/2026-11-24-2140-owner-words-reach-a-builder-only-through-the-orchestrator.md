# Owner words reach a builder only through the orchestrator

Status: accepted, 2026-11-24 (#1198). Amends 2026-11-16-0007 and 2026-11-18-2330.

## Context

An owner's thread message on a card In Progress reached two readers at once: the orchestrator, and the running
builder as news. On T-856 the owner's Filed-lines message reached its builder, which asked whether to build it,
while the orchestrator had already filed it as its own task. The orchestrator is the one that knows what the owner
means across cards; a builder that hears every message at once acts on words that belong elsewhere.

## Decision

- The owner's message on a building card is no news: `tapPlan` no longer passes it to the builder.
- The orchestrator relays what belongs in the build with `builder resume --quote <event id>`, which puts the owner's
  message, word for word, ahead of its own note ("Owner, verbatim: …"). The thread line "Passed to the builder"
  shows it was passed on. Otherwise it files the message or answers it.
- `builder done` refuses while an owner message sent since the build started still waits on the orchestrator (the
  card's reply wait), so nothing lands past an unread stop or change. A relay, a filing or an answer ends the wait.
- The builder brief says the owner's messages during the build reach it only as relayed.

## Consequences

- A message waits for the orchestrator's next wake before the builder sees it: seconds while its session runs.
- The orchestrator's words, new notes sections and the owner's relayed words still reach the builder as news.
- The orchestrator already answers a builder's own asks, so those are unchanged.
