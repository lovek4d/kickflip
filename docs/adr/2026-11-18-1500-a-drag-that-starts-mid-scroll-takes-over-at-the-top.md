# A drag that starts mid-scroll takes over at the top

Amends 2026-11-14-1700 (swiping a sheet down drags it to dismiss). `swipeMayStart` decides at touchstart, so a finger that began on a scroller scrolled down never dragged, even when the same stroke scrolled the content to its top and pulled on: the owner could not pull the Notes sheet down that way. `BoardUI.swipeToDismiss` now holds such a touch (not one in a text box) and asks `swipeMayStart` again on each move; once the scroller is at its top the drag starts from that finger position, with the same verdict. Every sheet gets it.
