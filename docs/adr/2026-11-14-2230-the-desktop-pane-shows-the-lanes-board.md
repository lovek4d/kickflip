# The desktop pane shows the lanes' board

The desktop Waiting on you pane (view-questions.js embedded by app-pane.js) loaded `/api/board` on its own, apart from the lanes: a second download of the same board, polled on its own clock, and painted when its own load landed.

- Embedded, the page holds no load, copy or poll. The lanes' board is its board: app-pane.js's `renderPane` hands it every board the lanes land (`take`), and it paints the held one when the pane mounts.
- A tap in the pane sends through the lanes' `send`, so the answer lands in the lanes' board, which the pane then draws; the pane no longer lands the POST's board itself. A load the pane asks for is the lanes' `loadBoard`.
- The phone's page is unchanged: it is a page of its own and keeps its saved copy and its own load ([Waiting on you keeps its topic and paints from the saved copy](2026-11-14-1500-waiting-on-you-keeps-its-topic-and-paints-from-the-saved-copy.md)).
- Out of reach, the pane shows what the lanes show (the board's down landing or old copy); it no longer draws a landing of its own.
