# While typing, the header is a strip and the send bar sits on the keyboard

#303 docked the Questions page's bar on the keyboard, but on iOS the page still scrolled under the keyboard and the header, fixed to the bottom of the layout viewport on a phone, slid in and out. The owner asked (#325) for the header to leave while any text field is focused, on every page, so the send bar can stay anchored above the keyboard, and picked take B of prototype focus-header: the header collapses to a 26px strip naming the page, and the docked bar carries the Questions page's answered count or a thread box's What's left? chip, with Send.

- One dock for the whole app, in shell.js, replaces #303's in view-questions.js. It sets `:root.kb-up` while a text field is focused and visualViewport shows a keyboard, with `--keyboard` (the covered height) and `--keyboard-top` (visualViewport.offsetTop), and marks the field's reply form or Questions page `.docked`. The names differ from dialogs.js's per-sheet `--kb` so the root value never leaks into a sheet or the settings modal.
- The strip is the real header restyled (style.css): fixed at `top: var(--keyboard-top)`, everything but the title hidden, with "· typing" after it, as the prototype drew. It sits at the top of what shows, as drawn, rather than at the header's usual phone place at the bottom, which the keyboard covers.
- A docked thread row hides the eye, the fire, the bolt and Done, keeping the chip and the send buttons (Send, or a Todo card's Implement and Reply), since take B drew only the chip and Send.
- Once docked, the bar stays until the keyboard goes rather than leaving on blur: a tap on a docked Send blurs the field first, and a bar that moved on blur would move out from under the tap.
- Other text fields (a card's edit box, settings, a sheet's fields) collapse the header too but dock no bar; a sheet already sits on the keyboard (dialogs.js fitSheet).

Not checked on a phone: the tests cover the dock's state from a faked visualViewport and the CSS rules by text. iOS reports visualViewport late while scrolling, so the strip and the bar may still lag a scroll there; only the phone can show it.
