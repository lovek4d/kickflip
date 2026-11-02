# The page scrolls behind a modal from 900px

The page scroll lock keeps a phone's bottom sheets in place, but on a wider screen it also stops the page behind every modal. The owner settled on hub/INT-216 to keep the phone behaviour and let the page scroll from the app's 900px rail breakpoint.

- From 900px, the page keeps scrolling behind every modal (`dialog:modal`), including shortcuts, New task, links, board and hub settings, confirmations and New board. A wheel on a modal's own scroll area stays inside it through `overscroll-behavior: contain`.
- Below 900px, the lock from hub/INT-153 and `fitSheet`'s scroll restore stay. On iOS, a page scrolling under a bottom sheet moves the sheet off the screen's bottom with the keyboard up, and a drag on the backdrop pans Safari's toolbar.
- `fitSheet` checks the width on each page scroll. While wide it remembers the current position; if the window narrows with a sheet open, the lock keeps that position instead of returning to where the sheet opened. Its fitting and viewport listeners stay as they are.
- A spike of a board as a scroll box with a popover sheet was “probably the best so far” but “not perfect” on the iPhone. It needed a scroll box, a popover without a focus trap and a touch guard.
- `interactive-widget=resizes-content` (WebKit 318324@main, not yet in Safari) is the fix to revisit.

The owner said: “if there's a lot of complexity to implementing this, I think it's fine to just lock it in place on mobile”.
