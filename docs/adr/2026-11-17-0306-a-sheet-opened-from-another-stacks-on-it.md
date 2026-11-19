# A sheet opened from another stacks on it

Supersedes [a sheet opened over another lands on top first](2026-11-16-2000-a-sheet-opened-over-another-lands-on-top-first.md).

A prototype opened from the questions sheet replaced it, so its Choose this had to close the prototype and send the owner back to the question through the shell. On a phone the questions sheet then drew its old copy without the pick, and the owner saw the sheet close with nothing picked. The owner asked for a standard seam instead: modals opened from modals always stack.

The sheet stack lives in `ui.js`, and every sheet opens through `BoardUI.openSheet` and closes through `BoardUI.closeSheet` or its own `close()`:

- **A sheet opened while another is open stacks on it.** The one beneath stays open where it was, scroll kept. A modal sheet lands in the top layer; a non-modal one (from 900px) lies above by its `--layer`, which `style.css` adds to the reader sheet's z-index. This holds whatever the sheets are: questions, reader (notes, transcript, a prototype, a visual), or any other.
- **No layer has a history entry.** A sheet opening, closing or stacking pushes, pops and reads no browser history and no fragment ([sheets make no history](2026-11-19-0110-sheets-make-no-browser-history.md)). Back leaves the board as from any page; a sheet closes by its ✕, a swipe, Escape or a tap on the dim area, through its own `cancel` handler.
- **A layer leaves the stack as it closes.** `closeSheet` takes it out as the close starts, and a `close` event does for a sheet shut another way (a swipe, a view unmount).
- **The layer beneath, back on top, gets a `sheet-return` event.** The questions sheet redraws from the drafts on it, so a pick Choose this drafted shows at once.
- **A sheet opened again while under another comes back on top**. One already on top stays as it is.
- **A sheet that shows pages stacks a page on itself.** The reader is one dialog, so a page it opens over the one it shows is a layer of its own in the same sheet (`BoardUI.pushPage`). The page beneath keeps its body, hidden, so a framed visual keeps running and a transcript or notes keep their scroll. Its ✕, Escape, a swipe, a tap on the dim area (`BoardUI.popPage`) show the page beneath again; only the last page's close closes the sheet, and closing the sheet takes all its pages with it.
- **A sheet shows at its topmost layer.** A page the reader opens while it lies under the questions sheet raises it; taking that page off puts the reader back under the questions sheet, which shows again where it was. A sheet that shows again in its place keeps its scroll.
- **Escape on a non-modal sheet closes only the top one** (`BoardUI.isTopSheet`).

In the reader, a link to a card page (a prototype, a round of one, a visual), a transcript or a card's notes opens over the page shown, and a question of the board opens the questions sheet stacked on the reader; closing it returns to the reader where it was. A transcript or notes opened from the board while the reader is open opens over what it shows too. Any other link closes the reader, every page in it, and opens through the shell.

Choose this now closes only the prototype's page when the questions sheet under it shows its question (`app-reader.js` `leave`): the reader closes, or shows its page beneath under the questions sheet again; with no questions sheet under it, the reader closes and the shell opens the question, as before.

A row in the desktop pane, and a questions URL on a phone, still put the questions sheet in the reader's place, as [a topic in the questions pane closes the overlays over it](2026-11-12-2359-a-topic-in-the-questions-pane-closes-the-overlays-over-it.md) has it: the questions sheet lands on top first, then the reader closes under it (`app-pane.js` `questionsOverReader`). The pane is no sheet, so its rows don't stack. `swapSheet` and its 220 ms timer are gone.
