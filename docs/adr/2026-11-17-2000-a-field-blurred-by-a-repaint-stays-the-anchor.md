# A field a repaint blurred stays the anchor until the owner scrolls or presses

A card with its reply box focused that changes lane is redrawn, and the box is drawn anew or blurred. On a phone the
refocus `keepFocus` makes doesn't raise the keyboard, so the keyboard closes. The page then resizes and scrolls
without the owner, and the focusout and scroll handlers took the topmost card on screen as the anchor, so the
box's card left and the page held the other cards.

`steady` now pins the field it was repainting around. The pin stays the anchor, drawn anew or not yet drawn, through the
focusout and the keyboard's resize and scroll, until a pointer press, a wheel or a key press, which are the owner's.
On a computer nothing changes, since the refocus keeps the field focused; on a phone the box ends up where it was on
screen and one tap brings the keyboard back.

Holding the card in place until the field loses focus was the first proposal. The owner chose to let the card move and
the page follow it.
