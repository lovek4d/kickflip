# A button drawn as a status line resets in one rule

A stalled build's status line is a `<button class="sub agent stalled">` where a live one is a `<div class="sub agent">`. The owner saw the card's line gain margin above it when it turned red.

Measured in headless Chrome at 390px, with the real style.css and the card's details/summary markup: the div and the button have identical boxes (same top, height, margins, line-height), so the card does not move there. The jump is therefore in a browser's own button box (the owner's phone), which could not be measured from a build session.

Decision: `button.sub` is the one reset (block, no margin-inline or margin-bottom, no padding, min-height 0, inherited family, weight, spacing and line-height, no appearance). It leaves the `font` shorthand out so `.sub`'s 12px stays, and leaves margin-top to `.line3`. `button.sub.agent.stalled` sets only the colour. Any other line that becomes a button takes the same reset.
