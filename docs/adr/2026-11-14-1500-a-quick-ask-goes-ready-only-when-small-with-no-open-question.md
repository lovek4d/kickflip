# A quick ask goes ready only when small with no open question

Card #709. Amends "A Quick build ask goes straight to ready" in [the orchestrator sorts new tasks itself](2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md).

The owner (11/13, t122-f-rule): "Only small, fully settled changes"; (11/14, t122-keep): "Keep it: make the rule mechanical".

Superseded by [a quick ask is triaged into staging](2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md): a quick ask is staged by item triage and goes ready from staging at any size.

## Decision

- `item add --from-ask` and `item set` on the New card an Implement ask became refuse `--phase ready` on a quick ask unless the card's size is small. The refusal tells the session to discuss it instead: reply, which reads it discussing.
- No open question is already a ready check for every card (`item set --phase ready` refuses a card with an open question), so a quick ask with one is refused the same way.
- A discussed task the owner staged is unchanged: the owner's Implement after the discussion is the settling, at any size.

Rejected: a guard that trusts the orchestrator's size call without the board checking it (the owner asked for the rule to be mechanical).
