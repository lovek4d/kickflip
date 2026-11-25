# A sheet stacks only from a tap inside another, and a stack reads as stacked

Amends [a sheet opened from another stacks on it](2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md), where any sheet opened while another was open stacked on it, whatever opened it: a tap on the board behind the desktop reader pane, a card's button, a push. The owner: "modals should only stack if opened from another modal, but should retain their non-auto opened status", and "if the root modal was auto opened, and then the stack above it closes back down, the root should return to auto dismiss logic".

The stack is still the `layers` list in `ui.js`, and it alone decides how an open lands (`BoardUI.opensOver`):

- **From a tap inside a sheet of the stack, a sheet stacks on the top one.** `ui.js` notes where the owner's last click landed, in a capture listener on the document; a page framed in the reader reports its own taps (`BoardUI.tappedIn`).
- **Any other open replaces the stack, so one root sheet is open at a time, at every width.** The owner (11/24): "Yes, one rule at every width", "Strictly One root sheet open at a time"; the desktop pane follows the phone's rule. The open sheets close top first as Escape closes them, through each sheet's own `cancel`, so each view's close path runs (the reader drops its pages, the questions sheet its topic). A row in the desktop pane or a question link on the board puts the questions sheet in the reader's place this way; `focusQuestion` no longer closes the reader itself.
- **A centred modal is the exception.** From 900px, board settings and Repo review open over the stack without replacing it ([board settings and Repo review open centred](2026-11-25-0100-board-settings-and-repo-review-open-centred.md)).
- **Reopening a sheet that is lower in the stack closes the sheets above it.** No second copy goes on top.
- **Each layer keeps its own flag, auto or by hand.** An auto-open is a push (the service worker's open), the questions or card-page URL the page loaded with (`shell.js` runs both within `BoardUI.opening('auto', …)`), or a card the owner opens on desktop (`followCard`, `followCardNotes`). The stack is **anchored** while any layer in it was opened by hand (`BoardUI.anchored`). Anchored, an auto-open stacks on top, and closing it returns to the owner's sheet (the owner's pick). Unanchored, it replaces the stack.
- **Only the top decides.** `followCard` and `followCardNotes` swap or close their sheet only when it is auto and on top, so a card tap never changes an auto root under the owner's sheet. Once the owner's sheets close back down to the auto root, it follows the card again.
- **A board mounting again reopens its sheets in the order they stood** (`BoardUI.opening('stack', …)`).

## The stack's look

The owner picked peek strips. `restack` marks each sheet beneath the top `data-under` with its `--depth`, and each sheet over another `data-over` with its `--below` (`style.css`):

- A sheet beneath shows `--peek` (24px) of its top above the sheet over it, scaled back 5% and fainter for each step down. Its head's title is drawn up into the strip, and its buttons are hidden.
- A standard sheet over another stands lower by its `--below` strips: a shorter height on a phone, a lower top in the desktop pane, where stacked panes also get a top border and corner.
- Only the bottom sheet's backdrop dims the board, so the strips show undimmed.
- A tap on a strip closes the sheets above that one.

The strips show each sheet's own head, without the auto or by-hand chip the visual drew to explain the flags. A small sheet (hold, links, pause) stands at its own height, so under a full-height sheet it shows no strip.

Escape, focus and pull-down-to-close are unchanged: each acts on the top sheet. Once a sheet is on top again, a pull down closes it.
