# The reader sheet is not modal on desktop

#537. From 900px the reader sheet (Notes and View transcript, app-reader.js) opens with `dialog.show()`: no backdrop, laid over the right pane only. The left pane stays live, so a click there does not close it and a file dropped on a text field there attaches as usual. It closes on its ✕, Escape (a keydown on the document, since a non-modal dialog gets no cancel event) and Back. Below 900px it stays the modal sheet where a tap outside closes it.

Adds to [A builder's log and a card's notes open in a sheet](2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md).
