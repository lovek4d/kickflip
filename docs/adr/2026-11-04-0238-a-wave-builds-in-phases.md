---
status: accepted
---

# A wave builds in phases, and cards in one phase build side by side

This supersedes in part [a wave the owner asks for is a lineup of cards](2026-11-02-1202-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md): there, every lineup change rewrote a chain in which each card was blocked by the one before it, so a wave built one card at a time.

The owner, on #124's thread: "I don't necessarily think everything has to block. Ideally we can parallelize things within waves … It's just in phases that allow for the builders to not step on each other's toes." The owner's answers on #161 settled the rest: wave triage proposes the phases and the owner accepts them, a lineup takes repeatable `--phase` flags, existing waves stay as they are, and two cards in one phase that touch the same file need nothing special.

- **A lineup is a list of phases.** A lineup keeps `phases: [[id, …], …]` in build order. Each card in a phase is blocked by every card in the phase before it, and cards in one phase don't block each other (`store.mjs` `chain`). Its other `deps` stay.
- **The CLI takes one `--phase` per phase.** `lineup create <slug> --phase <wave>/<id>,… --phase …` makes it, and `lineup set <slug> --phase …` re-phases it, naming every card once. `--phase` replaces `create --cards` and `set --order`, which only described a chain: a chain is one card per `--phase`. `lineup add` puts a card in a phase of its own, last or after `--after`'s phase, and `lineup remove` drops a phase it empties. The order line and the Notes order read one phase's cards with commas and the phases with arrows ("#1, #2 → #3").
- **Existing waves stay as they are.** A lineup written before phases has `items: [id, …]`, which `domain.mjs` `lineupPhases` reads as one card per phase. Its chain is unchanged, and its next change writes it as `phases` with the same links. Only new and re-triaged waves have phases of more than one card.
- **Triage proposes the phases.** Plan waves proposes each wave with its phases, grouping cards by the files and areas they touch: cards that touch the same files go in different phases, and cards that don't share a phase. Wave triage on a lineup may also propose re-phasing it, as one question whose yes is `lineup set --phase`. The owner accepts through the existing questions, and nothing is made before a yes.
- **The band numbers cards by phase.** A lineup band's `phases` gives each card its phase's number, so one phase's cards share a step number. Its `next` is its first Todo card Implement can start now, else its first Todo card with the word for why not. So while a phase holds several ready cards, Implement starts the first, and once it starts the next ready one takes Implement.
- **A ⋯ move swaps places.** Move up or Move down swaps a Todo card with the Todo card before or after it. Each card takes the other's phase, and every phase keeps its size (`domain.mjs` `lineupMoved`). Two cards in one phase swap only their order on the band. Started and done cards don't move, as before.
- **Collisions rebase at land.** Two cards in one phase may still touch the same file. The later one rebases at land, as any card does today.

Considered:
- A `phase` number on each card id in `items`: two fields to keep in step whenever a card is added, removed or moved.
- Re-phasing existing waves when this lands: the owner kept them as they are.
- Move down putting the card in the next phase, growing that phase: a started card in the phase after could then be blocked by a card still in Todo.
