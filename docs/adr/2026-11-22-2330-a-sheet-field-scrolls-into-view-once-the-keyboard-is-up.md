# A sheet's field scrolls into view once the keyboard is up

Sheets focused their field with `preventScroll` (so iOS doesn't scroll the board behind the sheet) and nothing scrolled the
field into view afterwards, so iOS did it only at the first keystroke. `BoardDialogs.focusField` focuses with
`preventScroll`, then calls `scrollIntoView({ block: 'nearest' })` on the viewport's next resize, or after 400ms when the
keyboard was already up and no resize comes. New task and Close board use it.

The search bar is not a sheet (it lifts itself above the keyboard) and keeps its own focus call.
