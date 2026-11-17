# A quick ask is triaged into staging

Card #979 (T-636). Supersedes [a quick ask goes ready only when small with no open question](2026-11-14-1500-a-quick-ask-goes-ready-only-when-small-with-no-open-question.md) and the "A Quick build ask goes straight to ready" point of [the orchestrator sorts new tasks itself](2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md).

On T-633 the owner sent a task with New task's Implement; the orchestrator triaged it `--phase discussing`, `item triage` took it, and the tap was lost, so the owner had to tap Implement again. The owner (11/17): "isn't it one single branch from implement new task to implement staging? That should strictly always be the case, post ingestion to a proper ticket".

## Decision

- **One path.** An Implement ask, sent with New task's Implement (`ask {quick: true}`) or with Implement tapped on its New card, becomes its card staged. `item triage` on one takes `--title` and the links, and no `--phase` but `staging`; it refuses discussing, grilling, prototyping and visual, writing nothing. It lands the card staging with a Marked as staged line, as a thread Implement does, and records `triaged.phase` staging.
- **Judged as any staged card.** From staging the orchestrator runs the staging checks and readies it with `item set --phase ready --text "<what you checked>"`, at any size (the owner's Implement is the settling), or sends it to grilling or prototyping with a thread line saying why.
- **The side path goes.** `item set` refuses `--phase ready` on any card not staging or ready; there is no quick-ask exception and no small-only refusal. `item add` never files ready. `item add --from-ask` and `item set --from-ask` refuse an Implement ask at any phase, since item triage stages its New card. The intake wait and the Implement-on-New event line say the same.
- **Slack still discusses first.** An ask routed from a Slack @kickflip is no Implement ask, even with an Implement on its New card ([an @kickflip in a Slack DM is filed as a routed ask](2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md)): it triages into a phase as a Discuss ask does, and goes ready once the owner stages it.

`domain.mjs` `implementAsk` is the one test of an Implement ask, read by the store's triage and refusals and by the intake wait.

Rejected: refusing only discussing at triage while keeping the small-only ready path (the first notes for this card), which left two paths where the owner expects one.
