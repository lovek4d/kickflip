# A question for several cards moves to the card built first

Amends [triage runs once overnight on cards waiting on your answers](2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md): its "Merging questions" bullet no longer applies.

The owner, on #232 (11/05): a merged triage question should be moved onto one card, scoped to a single work item, never answering for several. That card is built first; the others block on it, and their copies resolve with a note that the question moved or is a duplicate.

- **One command.** `question move <id>,<id>,… --to <wave>/<id> [--block <keys>]` (`store.mjs` `moveQuestions`). The first id keeps its text and moves to topic `item:<to>`; the rest resolve "Duplicate of <ref>'s question <first>". Only open questions move.
- **Order.** Each `--block` card is blocked by the one before it (the first by `--to`), so the cards build in the order given, and is related to `--to`; the skill tells a blocked card's builder to read the related card's thread and notes.
- **No server change, no `cards` field.** The answer is an ordinary owner answer on one card and starts it as any answer does; nothing is copied onto other cards. One topic per question still holds.
- **Dropped.** The audit's row 8 (Send filing architecture findings): task creation goes through the orchestrator from the thread, so `arch file` stays the session's.

Flipping Todo's order is #305.
