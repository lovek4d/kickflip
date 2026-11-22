# A sheet's height follows rotation from CSS; the pin and its timer go

A phone sheet's height was measured by `dialogs.js` `fitSheet`: `--sheet-full`, the tallest the viewport had been
while the sheet was open (the visual viewport's height plus the keyboard), and `--vh`. It only grew, and only a change
of the window's width reset it. While the phone turns, iOS briefly reports a wrong viewport; the sheet locked onto
that too-tall height and pushed its header off the top. A window `scroll` listener (the pin) also wrote the page's
scroll back while a sheet was open, and re-measured the sheet 350 ms later, because `innerHeight` read short while iOS
scrolled the page for a focused field.

Now every sheet height is CSS's `100dvh`, which follows rotation and ignores the keyboard (iOS and Chrome's default
`resizes-visual` keep the layout viewport the same size under it). `fitSheet` measures one value, `--kb`, the part of
the layout viewport the keyboard covers, on the visual viewport's `resize` and `scroll` (its pan changes `offsetTop`),
and on the window's `focus` for a file picker's return. A wide sheet that floats above the keyboard takes
`100dvh - --kb`.

This deletes `--sheet-full`, `--vh`, the window `resize` listener, the pin, and its timer. Below 900px the page under a
modal stays still by CSS alone (`html:has(dialog:modal) { overflow: hidden; }`), and sheet fields focus with
`preventScroll`. Bringing a focused field into view once the keyboard is up is T-827's focus helper.

The cause comes from the T-782 review. T-832's simulator run could not rotate or end a touch, so no logged phone run
confirmed it. Covered by `board/view.test.mjs` (fitSheet sets only `--kb` and never writes the page's scroll) and
`board/reader-pane.test.mjs` (no CSS reads a measured height).
