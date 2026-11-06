# Every card update takes the one tint

[An updated card takes a brief tint](2026-11-02-2354-an-updated-card-takes-a-brief-tint.md) kept two signs: a blue border flash for a card that changed lanes or joined Todo, and a background tint for any other update. The owner asked for one (hub/GH-344): every update, a lane change, a new card, a status or thread change, ingestion, looks the same, the full tint.

`board/public/app-snapshot.js` `highlight(el)` is the only function that signs an element, and `.tint` in `board/public/style.css` is the only class: an accent-soft background that holds briefly and fades over 2.4 s. A moved or updated card, and a changed line when the fresh board replaces the last visit, go through it. The border flash, its `.flash` class and its keyframes are gone. Cards the owner changed from this page stay unsigned, as before.

The line-level sign (lane counts, Needs you lines, thread messages) takes the tint too, so no border variant remains anywhere on the board.
