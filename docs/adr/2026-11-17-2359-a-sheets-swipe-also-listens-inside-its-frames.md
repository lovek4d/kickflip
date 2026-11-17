# A sheet's swipe also listens inside its frames

Amends 2026-11-14-1700 (swiping a sheet down drags it to dismiss). A page in a frame, such as a visual or prototype in the reader sheet, gets its touches in its own document, so only the sheet's header dragged. `BoardUI.swipeToDismiss` now also registers the same start, move and end on the document of every same-origin iframe in the sheet, found at each frame `load` (a capture listener on the sheet; a sheet registers before its page loads). No caller changes: every sheet already gets the swipe through it.

The drag starts once every scroller between the finger and the sheet is at its top: the walk goes up the frame's page, then on from the frame element into the sheet, and the frame document's own scroll counts. The drag is measured in `screenY`, since a frame moves with the sheet and its `clientY` would not hold still. A frame of another origin can't be reached and keeps the header-only drag.
