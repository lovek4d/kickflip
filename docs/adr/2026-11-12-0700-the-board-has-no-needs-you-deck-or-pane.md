# The board has no Needs you deck or pane

#561. The owner: "throw out the needs you section on mobile and on desktop … The question mark in the header is a fine way to get to it, and everything else should be visible with action needed. Plus we are moving away from questions being a every item thing."

The board draws no Needs you of its own at any width. The phone's deck at the top of the board (`#needsDeck`) and the desktop pane beside the lanes (`#needsPane`, its `#waiting` lines over an embedded Waiting on you and the prototype viewer) are gone, with `app-needs.js`.

- **Open questions.** The header's ?, with the open-question count as its badge (`app-header.js`), opens Waiting on you at every width. Waiting on you is a page of its own on a desktop too, so a questions URL, a push or a link shows that page and never the board (`shell.js go`), and the page tree is the board, Waiting on you, then a prototype at every width (`router.js`).
- **Prototypes.** A prototype opens its own page, as on a phone, never a pane.
- **The rest of what waits.** A card waiting on the owner shows its Action needed. A held review is in the Auto Review lane and opens from its push's `#review=` link.
- **Pending prompts.** The hub page lists every pending prompt, a board session's naming its board, and a prompt's push opens the hub page (`hub/prompts.mjs` `pending`, `pushOf`). The hub badge counts each once: a board's prompts in its board's count, the rest on their own.
- **Layout.** From 900px the lanes take the board's full width. The lanes | pane seam and its width (`--pane-w`, `hub:paneWidth`) are gone; the sidebar's edge still drags. The reader sheet lays over the right half of the space beside the sidebar.
- **Fragment.** A board's URL fragment has no `openItemsCard` pill any more: `#selectedCard=`, `#review=` and `reply` are what it reads.

`domain.mjs` `needsOf` stays: the hub's per-board count, its needs lines and Waiting on you's topic order read it.

Supersedes [Needs you is a deck on a phone and a pane on a desktop](2026-11-05-0408-needs-you-is-a-deck-on-a-phone-and-a-pane-on-a-desktop.md), [a deck option sends on a second tap](2026-11-07-1212-a-deck-option-sends-on-a-second-tap.md) and [on desktop the prototype viewer opens in the right pane](2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md). Supersedes in part [Board and Open questions are two pages](2026-11-07-1300-board-and-open-questions-are-two-pages.md), [the desktop columns drag](2026-11-10-1600-the-desktop-columns-drag-and-this-device-keeps-their-widths.md), [on desktop the reader takes the Waiting on you half](2026-11-11-1300-on-desktop-the-reader-takes-the-waiting-on-you-half.md), [the + lives on the board pane](2026-11-05-2330-the-plus-lives-on-the-board-pane.md), [a prototype stage shows what the board hides by width](2026-11-12-0300-a-prototype-stage-shows-what-the-board-hides-by-width.md) and [a background session's prompts come to the phone](2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md).
