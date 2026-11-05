# The orchestrator links a new card when it files it, and planners and builders read the links

Filing a card is ingestion. In the same step that files a new card, the board's session (the orchestrator) reviews the pending cards related to it, links them, and writes a cross-card note into each affected notes file. A card reaches Todo, where its grill launches, only with its links in place. Headless planners and builders read the links from their brief.

**Link in the filing call.** `item set <key> --relate <keys>` adds links and keeps the rest; `--unrelate <keys>` takes them off, on both cards, since a link shows on both whichever card stores it. `--related` still replaces the whole list and doesn't go with either. For an ask, the one turn that files it links it: `item set <key> --from-ask <id> --text … --relate <keys> --state …`.

**An agent's card is filed New.** `board.mjs item add` without `--state` writes the card `unfiled: true`. It reads New, the way an unfiled ask does (`board/domain.mjs` `unsorted`), and is never pulled. A `card-added {key, title}` event wakes the session. Its one filing turn writes the notes, the links and the Related lines, then sets `--state`, which clears `unfiled`. The session's own cards skip that turn: `item add <wave> --title … --state <s> --relate <keys>` files the card in one call. Server-made cards (an architecture review's) are added as before.

**Filing comes before the grill.** An unfiled card is not an arrival (`board/domain.mjs` `arrivalsOf`), so the board grills it only once the session files it ([every card arriving in Todo is grilled by the board](2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md)). Since `item add` without `--state` now means unfiled rather than grilled, `item add` takes any card state again, not only ready: the session's own card is filed `--state grilling` (or prototyping) and linked in one call, and a ready card still needs its size and notes file.

**A Related line in each notes file.** For each card the new card is linked to, the session appends a short `## Related` line to that card's notes saying how the two overlap, and does the same in the new card's notes.

**Briefs list the links.** `briefFacts` gains `links`: the card's Parent, the cards it depends on, and the cards it is Related to (set on either card), each as `{relation, ref, title, status, notes}`. The builder and planner briefs list them under "Related cards: read their notes for context; don't build their scope." The lander's brief doesn't.

The owner (#206, #223): "if a new work item comes in and the orchestrator is notified, it can review what other work items are pending related to that. That should be part of the ingestion process. And then those links that the orchestrator adds between tickets is something that the headless planners can use to inform themselves of the broader context." And: "they should be linked at new task ingestion or creation from another item, this shouldn't be a separate turn for the orchestrator. the prepared ticket should not land in the todo queue without links established." On a card made by an agent: New first.

Considered:
- the filer links its own card (`item add --relate` from a builder or planner): each filer sees only its own card's context, and two planners running at once don't see each other;
- a headless planner links at grill time: it would run after the card reaches Todo, and the owner wants the links in place before then;
- leaving it to the overnight triage: it runs once a night, only for cards waiting on questions, after the planners have run;
- an add-one form of `--related`: `--relate`/`--unrelate` say what they do, and `--related` keeps its replace meaning.
