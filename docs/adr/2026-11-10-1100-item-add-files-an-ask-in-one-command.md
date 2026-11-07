# `item add --from-ask` files an ask in one command

Filing an ask took `item add --state grilling` then `item set --from-ask`. The board launched a grill on the add, before the set, so a Quick build ask could get a stray grill that asked the owner its questions twice (#374).

- `item add` takes `--from-ask <eventId> --text <t>` with `--state`. The ask is checked (`checkAsk`, `refuseMoved`) and `--state ready` is checked before the ticket is assigned, so a refusal writes nothing.
- A Quick build ask files `--state ready`, with `--size`; the orchestrator now triages and creates the item, so there is no staging step before it. Any ask files grilling or prototyping. Staging stays the board's, set after the owner answers.
- `--state ready` on `item add` without `--from-ask`, or on a Discuss ask, is refused.
- After the write, add does what `item set --from-ask` does: sets `from_ask`, writes `--text` as the first thread line and drops the ask from ask-links. `item set --from-ask` stays for an ask filed onto an existing card.
- Supersedes the staging ADR's "`item add --state ready` is refused" for a Quick build ask (2026-11-07-0700-staging-then-ready.md).
