# The questions sheet's Send is a fixed footer

T-619. The owner picked take A from a prototype round, a fixed footer over Send in the header (B) and Send inline at the end with a count chip in the header (C). They then asked for the sheet to be cleaned up on a phone.

- **A footer outside the scroll.** The sheet's dialog is the reader sheet's head, then a form holding the scrolling body and a footer with the status and Send (`BoardQuestionsSheet.markup`, used by the board's sheet and the Waiting on you page's). The footer stands flush to the sheet's bottom edge, with a hairline above it. Before, the bar was `position: sticky` inside the scrolling body, with `bottom: var(--app-bottom)`. On a phone the sheet already stands on the bottom bar, so that offset counted the bar twice and left an empty strip about 53px tall under Send.
- **The form draws no box.** `.qs-form { display: contents }` keeps body and footer as the sheet's own flex rows. The sheet rules for `.sheet form` and `.sheet.keyboard-sheet form` (padding, max-height, scroll) then do nothing to it. One form still wraps both the cards and Send, so Send and ⌘↵ (`keyedSend` looks in the form) submit the cards.
- **The keyboard lifts the footer.** While open, the sheet runs `BoardDialogs.fitSheet`, as New task does. The footer pads `--kb` under Send, so the body shrinks and Send sits just above the keyboard. Fitting stops when the sheet closes without showing again (ui.js restack closes and shows it at once) and when the view goes.
- **The status counts answers.** It reads "n of m answered", m being the open questions not already on their way. A message such as "Pick an option or write a note first." stands until the next change redraws the count.
- **Cleanup.** The first card sits 12px under the head and the last ends 12px over the footer. Phone gutters are 12px under 700px. Round headings are 12px and muted. The header's ref line, the card's number row and the note box's height are unchanged.

`questions-sheet-footer.test.mjs` measures the footer in Chrome at 390px with and without `--kb`, and at 1280px.
