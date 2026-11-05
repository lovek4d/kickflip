# The + is the board page's alone

The + (new task) and its sheet are in the board view's own markup (app.js) and nowhere else. shell.js no longer adds them to the board's other pages (prototype pages and the prototype viewer, thread pages, Hub pages, settings, notes, frames); the Open questions page already had none (docs/adr/2026-11-05-2330-the-plus-lives-on-the-board-pane.md).

Opt-in rather than opt-out: a new page gets no + unless its view puts `BoardNewTask.markup()` in its root and wires it, so it never needs a per-page exclusion.
