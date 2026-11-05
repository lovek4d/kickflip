# A lightning button in a Todo thread's footer starts a quick build

The owner (#265, from #257's thread) asked for the lightning in the thread footer, left of the prototype eye, to start a quick build of the card whatever its grill or prototype status. Picked as take A of `prototypes/bolt-button`: lightning, eye and fire on the left, #256's Reply and Reply and build on the right.

- The bolt shows only on a Todo card and follows the card's lane on each board load, as the send buttons do (app-threads.js `syncDone`).
- A tap needs no confirm and ignores the box. It sends `item-message {key, text: 'Quick build', intent: 'build'}`, the same event as Reply and build, so the session marks the card ready and builds it, and the message's footer reads "build requested". The button spins through `waitOn` until the card moves.
- The icon is the one the quick build status line uses (`MARK_ICONS`), as a button beside the eye and fire (`BoardUI.boltButton`).
