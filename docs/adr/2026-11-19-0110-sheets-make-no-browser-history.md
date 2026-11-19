# Sheets make no browser history

Opening a card's sheet pushed a history entry at the page's URL, so Back could close the sheet. The entry beneath it kept the old `#selectedCard=…`: expand A, then B, close A, close B, and the back that spent B's entry landed on one still naming A. The hashchange re-added A to the open cards.

A sheet, and a page the reader stacks on itself, now pushes, pops and reads no history entry and no fragment. Back leaves the board as from any page; a sheet closes by its ✕, a swipe, Escape or a tap on the dim area. A card's link (`#selectedCard=…`) still opens its card on load. `BoardUI.afterSheets`, the popstate handler and the `page-back` event went with the entries.

Chosen by the owner over a back step that keeps the address (the sheet's back would remember `location.hash` and put it back): that kept the entries, and Back closing a sheet had no other use the owner wanted.

Supersedes the history parts of [a sheet opened from another stacks on it](2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md) and [the questions sheet makes no history](2026-11-16-0100-the-questions-sheet-is-opened-by-buttons-and-makes-no-history.md) (which now holds for every sheet).
