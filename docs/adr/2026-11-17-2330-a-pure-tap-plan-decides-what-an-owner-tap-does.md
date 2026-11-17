# A pure tap plan decides what an owner tap does

What an owner tap did to a card, by its lane and phase, was decided inline in the board server's `answer`: the stale
version's 409 and its "already X" words, a bare Implement staged as is against an Implement with words against a
Reply, a Block or Done stopping the card's agents unless it was landing, a held Merge against a plain one, and the
planner requests' briefs. A new button or phase meant editing the HTTP handler, and a tap's effect could only be tested
through a running server and a POST (T-596 architecture review, finding 4; the owner took option A).

`tapPlan(card, kind, body)` in domain.mjs now decides it, from the built card (or none) and the tap's event data:

- `{refuse: {status, words}}`: the tap changes nothing.
- Otherwise the effects to run in order, each `{do, ...}`: `event`, `clearStall`, `clearOwnerWait`, `passNews`,
  `stage` (as is, implement or reply), `record` (store.mjs `recordOwnerTap`, with the words a write with nothing to do
  refuses with, and whether the agents it closed are stopped), `resume`, `merge` (held or not), `build`, `plan` and
  `moveLand`. Where `event` stands is where the tap's event is recorded, so a tap's thread line and the lines its
  effects write keep their order; a plan without one records no event (a bare Implement, a Merge, a Build).

`TAP_KINDS` names the kinds it decides: the card taps, `item-message`, a bump and unbump, and the Grill, Prototype,
Visual and Review requests. The server's `applyTap` runs the effects through store.mjs and turns a refusal on the way
into a `BoardError` with its status. `answer` keeps the request's auth, the sendId and repeat dedupe, the Block's
duration check and the reply.

The plan reads only the built card, so two facts the handler read from files are now card fields:

- `landing`: the card's own newest status line is the finish step's landing line, as store.mjs `isLanding` reads it.
- A held Merge is the card's `mergeReady`, which the card carries in In Review with no PR, where its Merge button
  shows. The handler read the stored `merge_ready` in any lane; a Merge drawn from another lane, with its version, is refused as stale.

Each lane-and-phase rule has a table test in domain.test.mjs. The CLI and Slack intake can call `tapPlan` with the
card `builtCards` gives; neither does yet.
