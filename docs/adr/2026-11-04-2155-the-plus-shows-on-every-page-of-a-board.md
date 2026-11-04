# The + shows on every page of a board

The + button and its new-task sheet are `new-task.js` (`BoardNewTask.markup()` and `.wire(B)`), not part of the board view alone. The board view puts them in its markup; the shell (`shell.js show`) adds them to every other view whose route is a board (Waiting on you, Notes, a framed board page), and the hub's own pages get none. A board view sends the ask through `B.send`, which lands the board; another view sends it through its site. Press n twice works on each, and in a framed page too, since `view-frame.js` feeds the frame's document to the same handler.

The draft, store and `quieted`/`sendDraft` helpers moved into `base` in `app.js` so any view has them. On Waiting on you the + sits above the sticky Send bar so it doesn't cover Send.

Asked by the owner: "+ button should appear on every page for a board, main board and open questions".
