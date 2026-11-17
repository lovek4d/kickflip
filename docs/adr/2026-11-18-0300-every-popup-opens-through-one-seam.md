# Every popup opens through one seam

Card #1010 (T-676). Owner (11/17): "filters pop up (and every pop up, use a common seam) should go above the modal
(highest layer really, always), and also maybe make sure it is bounded to the visible screen boundaries as well while we
do that".

A sheet opened with `showModal()` sits in the browser's top layer, which no z-index beats, and a non-modal sheet
(z-index 30 and up) beats anything inside the header, whose sticky `.top` is its own stacking context at z-index 5. So
the board filter's checklist (z-index 40 inside the header), the card menu, the board menu and the rest drew under the
sheets. Each popup also placed itself its own way: CSS under its button with a phone rule flipping it upward, a hand
shift off the right edge, or a margin that made room below.

## Decision

- **One seam, `board/public/popup.js`.** `Popup.open(el, anchor, { align, onClose })` and `Popup.close(el)`. The owner
  draws the popup and keeps its own open state; the seam shows, places and closes it.
- **Top layer, always.** The popup gets `popover="manual"` and opens with `showPopover()`. A popover shown after a
  modal or a sheet goes into the top layer above it, so a popup is the highest layer with no z-index.
- **Placed by its anchor, kept on screen.** Under the anchor, or above it when it doesn't fit below and there is more
  room above; its left edge on the anchor's, or its right edge with `align: 'end'`. It is then clamped on both axes to
  `window.visualViewport`, less 8px or the safe-area inset, whichever is larger (`.popup`'s `scroll-margin` in
  style.css, which the script reads back), with its max-height the room left and its overflow scrolling. It places
  again on a resize of the window or the visual viewport, a scroll of the visual viewport, and any change to the page
  while open.
- **Closing.** A tap outside the popup and its anchor (the tap goes on to what it hit), or Escape, closes it and calls
  the owner's `onClose(escaped)`; after Escape an owner may put the focus back on its button (the board menu and the
  emoji grid do), which it must not after a tap that put the focus elsewhere. The Escape is the popup's only: the seam
  cancels it, so a modal under the popup stays open. Its
  anchor leaving the page closes it too; the popup's own element leaving the page (its owner drew the page without it)
  just ends it. One popup is open at a time.
- **On the seam:** the board filter's checklist (app-lanes.js), a card's menu (app-cards.js), the board menu
  (app-header.js), Main's failed-pull reason when it opens (app-cards.js paintMain) and Hub › Slack's emoji grid
  (slack-emoji.js). Their z-index and position rules, the phone rules flipping the filter and the board menu upward,
  the reason's hand shift, the emoji grid's margin and its own Escape and outside-tap handlers are gone; their look
  stays.

## Not popups

- Main's failed-pull reason on hover is still the CSS tooltip in place under the icon; only the reason that opens after
  a failed pull is a popup.
- The reader sheet's Rounds panel (`.ps-sheet`, ui-questions.js roundSheet) is a panel inside the reader sheet, which
  is already the top of the stack, and the prototype page's Rounds sheet is a bottom sheet: neither is on the seam.
- A `title=` tooltip is the browser's own.

## Consequences

- A new popup calls `Popup.open` after drawing; it needs no z-index, no edge rule and no close handlers of its own.
- Tests: board/popup.test.mjs in Chrome (above a modal, above a sheet over the header, inside the screen at its edges,
  Escape and outside tap); no-browser tests load popup.js and give the mini DOM `showPopover`/`hidePopover`.
- Related: T-670 (the filter menu's boxes), T-659 (sheet sizes, and stacking a modal over a modal).
