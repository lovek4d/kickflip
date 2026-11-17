# A sheet opened from another stacks on it

Supersedes [a sheet opened over another lands on top first](2026-11-16-2000-a-sheet-opened-over-another-lands-on-top-first.md).

A prototype opened from the questions sheet replaced it, so its Choose this had to close the prototype and send the owner back to the question through the shell. On a phone the questions sheet then drew its old copy without the pick, and the owner saw the sheet close with nothing picked. The owner asked for a standard seam instead: modals opened from modals always stack.

The sheet stack lives in `ui.js`, and every sheet opens through `BoardUI.openSheet` and closes through `BoardUI.closeSheet` or its own `close()`:

- **A sheet opened while another is open stacks on it.** The one beneath stays open where it was, scroll kept. A modal sheet lands in the top layer; a non-modal one (from 900px) lies above by its `--layer`, which `style.css` adds to the reader sheet's z-index. This holds whatever the sheets are: questions, reader (notes, transcript, a prototype, a visual), or any other.
- **One history entry per layer.** Each layer over another pushes one entry at the page's URL, carrying `sheets`, the number of sheet entries open with it. A sheet with nothing under it has an entry only when its opener asks (`entry`), as the reader does; the questions sheet and the others keep having none. Back pops to an entry with fewer `sheets`, and the stack dismisses each layer above it as Escape would, through the sheet's own `cancel` handler.
- **Closing a layer spends its entry, however it closes.** `closeSheet` leaves the stack as the close starts, and a `close` event does for a sheet shut another way (a swipe, a view's unmount). The stack goes back one entry at a time until history holds no entry past the open layers'. `BoardUI.afterSheets(fn)` runs `fn` once that back has landed, which the reader uses to open a link only after its entry is spent.
- **The layer beneath, back on top, gets a `sheet-return` event.** The questions sheet redraws from the drafts on it, so a pick Choose this drafted shows at once.
- **A sheet opened again while under another comes back on top**, keeping the entries as they were. One already on top stays as it is.
- **A sheet that shows pages stacks a page on itself.** The reader is one dialog, so a page it opens over the one it shows is a layer of its own in the same sheet (`BoardUI.pushPage`), with its own history entry. The page beneath keeps its body, hidden, so a framed visual keeps running and a transcript or notes keep their scroll. Its ✕, Escape, a swipe, a tap on the dim area (`BoardUI.popPage`) and Back (a `page-back` event) show the page beneath again; only the last page's close closes the sheet, and closing the sheet takes all its pages with it.
- **A sheet shows at its topmost layer.** A page the reader opens while it lies under the questions sheet raises it; taking that page off puts the reader back under the questions sheet, which shows again where it was. A sheet that shows again in its place keeps its scroll.
- **Escape on a non-modal sheet closes only the top one** (`BoardUI.isTopSheet`).

In the reader, a link to a card page (a prototype, a round of one, a visual), a transcript or a card's notes opens over the page shown, and a question of the board opens the questions sheet stacked on the reader; closing it returns to the reader where it was. A transcript or notes opened from the board while the reader is open opens over what it shows too. Any other link closes the reader, every page in it, and opens through the shell.

Choose this now closes only the prototype's page when the questions sheet under it shows its question (`app-reader.js` `leave`): the reader closes, or shows its page beneath under the questions sheet again; with no questions sheet under it, the reader closes and the shell opens the question, as before.

A row in the desktop pane, and a questions URL on a phone, still put the questions sheet in the reader's place, as [a topic in the questions pane closes the overlays over it](2026-11-12-2359-a-topic-in-the-questions-pane-closes-the-overlays-over-it.md) has it: the questions sheet lands on top first, then the reader closes under it (`app-pane.js` `questionsOverReader`). The pane is no sheet, so its rows don't stack. `swapSheet` and its 220 ms timer are gone.
