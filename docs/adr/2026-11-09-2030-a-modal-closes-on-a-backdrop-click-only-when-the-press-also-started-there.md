# A modal closes on a backdrop click only when the press also started there

A drag that starts inside a sheet or dialog (selecting text in a field) and ends on the backdrop fires a `click` whose target is the backdrop, so the modal used to close and lose the edit (#462).

`BoardUI.onBackdrop(ev, backdrop)` in `ui.js` is the one test every modal's backdrop close uses. A capture-phase `pointerdown` listener on the document records where the press began; the helper is true only when the click's target and that press are both the backdrop element. A click with no pointer press before it (a keyboard or scripted `click()`) never dismisses, which matches the backdrop being a pointer-only target. The dialogs that also compare the pointer to the dialog's rectangle keep that check after the helper.
