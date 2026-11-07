# An ask is titled in place and wears an Ask badge

The owner (#386): an ask that becomes a work item should be that item, retitled, with the original ask as its first thread item, not a second card filed beside it; and an ask that stays an ask should still get a title from triage, with an Ask badge in place of a ticket.

Asks and cards stay separate records. The data already made a filed card the ask's successor (its `from_ask`, a thread that opens with the ask, the ask's card left out of the board, old ask links opening the card); what showed a second card was intake filing in two steps, `item add` then `item set --from-ask`, with the card reading New beside the ask between them.

- Intake triage files an ask in one write, `item add <wave> --from-ask <id> --text … --relate … --state …` (2026-11-10-1100-item-add-files-an-ask-in-one-command.md), from a new task or a message in its thread. A Quick build ask is filed `--state staging` on `item add` too, as `item set --from-ask` already allowed, so the orchestrator judges it before ready; `--state staging` on any other `item add` is still refused.
- A card filed from an ask takes the ask's place: its `created` on the board is the ask's sent time, so Todo sorts it where the ask sat and its time line shows when the owner asked.
- `reply <eventId> --title <t>` and `item relate-ask … --title <t>` retitle an ask that stays an ask. The title is stored in `data/ask-titles.json` `{titles: {<ask event id>: title}}`; a reply to a message in an ask's thread titles that ask, and `--title` on a reply to any other event is refused before anything is written. An ask with no title keeps its first line.
- An ask that is no longer New (answered, folded, in progress or waiting on its questions) wears a quiet `Ask` badge where a work card's ticket is, and "asked <time>" moves to a line under its title (prototype round 1, take A). A New ask still wears `New`.
- An ask's ticket is still assigned only when it becomes a card.

Superseded in part by [the orchestrator sorts new tasks itself](2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md): the orchestrator, not intake triage, files and retitles an ask, and a Quick build ask files ready, not staging.
