# The ticket comment is a provider verb

A card's PR or landed commit is commented on its ticket
(2026-11-19-1600-a-tasks-pr-is-commented-on-its-ticket.md). That comment was
built beside the ticket layer
(2026-11-19-1700-one-ticket-layer-arbitrates-every-ticket-action.md) and named
GitHub and Linear itself.

`comment(id, body)` is now a verb of each ticket provider, beside link, create,
read, assign and move. `commentTicket` opens the provider, calls the verb and
reports the status line; nothing outside the providers names GitHub or Linear.
An unreachable source fails with the provider's `unreached.move` reason, as a
move does.
