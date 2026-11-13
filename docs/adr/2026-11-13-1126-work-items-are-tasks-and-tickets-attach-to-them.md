# Work items are tasks, and tickets attach to them

#644 (T-208). The owner asked (11/12): "Refer to work items as tickets, not cards." On the grill they set the scope to every word a person or agent reads (the skill, the glossary, briefs, CLI output and UI text) and picked the word: "make it task instead of ticket if that is already being used. work item / task is my mental model, that way tickets are still upstream or internal tickets attached to the task".

This amends [a task is a card with no ticket, keyed T-<n>](2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md), which made **task** mean a card with no ticket.

- **Task** is the board's work item, the thing the board calls an item in its files and the UI drew as a card. Every task is keyed `<file>/T-<n>`, with or without a ticket.
- **Ticket** is an upstream or internal issue attached to a task: a GitHub issue or a Linear issue in the board's ticket source. A task with none still shows the quiet `Task` badge in the ticket slot, now read as "a task with no ticket attached".
- **Card** goes as a word for the work item in CONTEXT.md, SKILL.md, the README, the headless briefs, the orchestrator's event lines, `board.mjs` usage and output, hub output and the board's UI strings.
- **What stays.** Code identifiers (`card`, `cardName`, `ui-cards.js`), CLI flags (`--card` on `prototype add` and `wave create`), event kinds (`card-hold`, `card-unblocked`, `card-bump`), stored fields, CSS classes and the `#selectedCard=` link stay as they are: renaming them would break stored data, links and scripts for no change in what anyone reads. Code comments stay too. ADR files and their titles, including where CONTEXT.md and SKILL.md link them, stay as written, since an ADR records the words of its day.
