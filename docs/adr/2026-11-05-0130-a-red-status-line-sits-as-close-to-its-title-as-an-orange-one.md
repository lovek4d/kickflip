# A red status line sits as close to its title as an orange one

Card #273. A stalled build's red status line showed a gap above it, up to 13.8px against the orange line's 3px, on a
one-line title (desktop, or a short title on a phone). #250's text test of the button reset could not see it.

## Decision

- **Cause.** A work card's bump icons (`.ask-actions`) float right and reach about 14px below a one-line title. A
  `<div>` status line shortens its line box beside the float. A `<button>` is its own block formatting context, which
  may not overlap a float, and `button.sub` set `width: 100%`, so it did not fit beside the float and dropped below it.
- **Fix.** `button.sub` sets no width. Its auto width fits beside the float; a long stalled line wraps beside it. The
  tap target is as wide as its words, not the row.
- **Test.** `board/layout.test.mjs` measures both lines in headless Chrome at 1280px and 390px and asserts equal offsets
  from the title. It is skipped where Chrome is not installed (`CHROME` overrides the path). #250's CSS-text test now
  also asserts the reset has no width.
- **Nudge.** A tap on the red line no longer turns it into a spinner. The line calms to the in-progress orange and its
  dot sends a ripple (`.nudging`), keeping its words and spacing, until a board shows the card's status line changed,
  the builder no longer stalled, or the card gone (`BoardUI.pending`, id `<key>:nudge`). A second tap meanwhile does
  nothing.
