# A handed ask is its sending board's orchestrator's

A handed-off ask (`handoff`) and a moved orchestrator ask carry `asked {by: 'orchestrator', route}`, `route` the board
that sent it. Without it the receiving board read another board's orchestrator as the owner: the thread drew it as
"You", triage lacked "not the owner, so its words approve nothing", and the New strip showed no author.

- The thread labels it `/<route>'s orchestrator` and draws it as a Claude line (markdown, unread like any).
- The New strip's entry shows the same byline, under its Orchestrator group.
- Triage's prompt says it is not the owner's.
- `moveAsk` and `passAsk` keep an orchestrator's ask as `asked` from the moving board; an ask carrying the owner's own
  text stays the owner's.
- Asks already in events.jsonl keep today's reading; no backfill. A byline on every event kind was left out.
