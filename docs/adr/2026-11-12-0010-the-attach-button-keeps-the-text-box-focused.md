# The attach button keeps the text box focused, and the keyboard sheet is measured again when the picker closes

Pressing the paperclip (`BoardUI.attachButton()`) no longer takes focus from the composer's text box: `attach.js` cancels the
mousedown on the file input, and a pick puts focus back in the box that held it. This sits in the shared button because every
composer uses it (2026-11-03-1722).

iOS hides its keyboard while its own picker is up, so the keyboard coming back takes one tap into the box; the cursor stays.

The New task sheet is sized by `--kb` from `fitSheet`, which listened only to visualViewport resize/scroll. A picker closing
sends neither, so `fitSheet` also measures on the window's `focus`, and the sheet is drawn from the current viewport, not a
stale `--kb`, so the next touch lands on the sheet and not its backdrop.

Not confirmed on a phone: the stale `--kb` is the suspected cause of the stray dismiss, from reading the code.
