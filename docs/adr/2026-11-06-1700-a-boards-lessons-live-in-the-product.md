---
status: accepted
---

# A board's lessons live in the product

Amends [the orchestrator links a new card when it files it](2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md): an agent's `item add` no longer files a card New for a `card-added` event to sort.

The hub orchestrator kept what it learned running a board in its own session memory. Each lesson about the product moves into the product, where it stops the mistake for any orchestrator:

- **`item add` on a board needs a state.** With `--site` it refuses a card with no `--state`, naming grilling and prototyping, so no card an agent adds reads New. `--held` holds the card as it is filed. Intake triage files a new card from an ask with `item add … --held` and its `item set --from-ask … --unheld` (a Quick build ask: `--state grilling --held`, then `--state staging --unheld`), so no planner starts between the two writes. #381 (`item add --from-ask`) and #411 (no intake triage) make it one write. `card-added` and the unfiled mark stay only for cards filed that way before.
- **A planner's done takes `--text`.** `builder done --text` on a grill's or prototype's run writes the text as the run's closing thread line ("Grilling: …"), as the planner brief has always asked.
- **A planner leaves nothing open in prose.** The planner brief says anything it leaves open becomes a question with `question add`, never only a line in the notes, so `item set --state ready`'s open-question refusal sees it.
- **SKILL.md** says to run the watcher only with `run_in_background`, never `&`, and check for one with `pgrep`; never to filter out the waits lines; that a card filed grilling gets its questions from the board's planner; and that a card given up on closes as done with `item set --done --text "<why>"`, with a follow-up card for what stays open.

Owner, on #340: "Make sure to encode things like this into the skill where you can, by the way. I don't want these to just be memories for this orchestrator. I want these to improve the product when they're relevant to the product."

The rule itself stays in the hub orchestrator's memory, not SKILL.md. Owner, on gh380-meta: "this skill is intended to be standalone, I'm just using the tool to build itself to dogfood it".

Considered: leaving a stateless `item add` allowed and only telling orchestrators to pass `--state`. The New badge on held follow-ups (#317, #324) showed the wording alone doesn't stop it.
