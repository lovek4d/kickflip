# The attach icon sits at the box's bottom right; the New task sheet closes only from outside its box

The owner on hub/T-510: "Attachment icon should be bottom right not left. Also tapping away from it hides the new task modal again." This amends [the attach icon sits inside the text box](2026-11-16-0730-the-attach-icon-sits-inside-the-text-box.md), whose notes added bottom-left unasked.

- **The icon is at the box's bottom-right corner** in every `BoardUI.dropZone` box; the box's bottom padding still keeps typing clear of it.
- **The New task sheet is its own backdrop target**, so a tap on its padding read as a backdrop click. It now closes on a click only when `BoardUI.onBackdrop` holds and `BoardUI.outsideBox` says the point is outside the sheet's box; X, Escape and a swipe down close it as before.
