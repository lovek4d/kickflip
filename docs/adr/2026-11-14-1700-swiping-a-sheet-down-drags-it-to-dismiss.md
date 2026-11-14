# Swiping a sheet down drags it to dismiss

`BoardUI.swipeToDismiss(sheet)` in `ui.js` is called before every `showModal()`, and `sheet-swipe.test.mjs` fails for a modal that skips it. On a touch screen a downward drag that starts on the sheet's header (`.sheet-head`, `.settings-head`), or anywhere when every scroller between the finger and the sheet is at its top, moves the sheet with the finger and fades the backdrop through `--swipe`. Text fields keep their selection gestures; upward drags and mouse are untouched.

A release past 30% of the sheet's height, or a flick over 0.6 px/ms, counts as Escape: the helper dispatches a cancelable `cancel` event, so the sheet's own close runs (New task's draft check included); a sheet with no cancel handler is closed directly. A sheet that is still open after that, such as one held by a confirm, springs back. The `closing` animations animate to the end from the dragged position, so no sheet needs its own slide-out.

A sheet that belongs to a view registers once when the view mounts and hands the returned remover to `B.atUnmount`, so an unmounted view leaves no listener behind.
