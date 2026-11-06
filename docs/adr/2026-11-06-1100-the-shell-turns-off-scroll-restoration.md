# The shell turns off the browser's scroll restore

After a reload for an update (#334's row) the page was black on a phone until the owner scrolled (#377). The shell already sends every view to the top (`scrollTo(0, 0)` in `go`), but `history.scrollRestoration` was still `auto`, so iOS likely put the old scroll offset back after the reload, once the board had grown from its saved copy, and WebKit left the newly exposed area unpainted until a scroll. Nothing in the app gates its paint on a scroll or resize (no opacity or visibility gate).

The shell sets `history.scrollRestoration = 'manual'` at start. Nothing visible changes, since every view opens at the top. A test checks the setting. It was not reproduced in the iOS Simulator, so the cause is the likeliest one, not a confirmed one; the owner checks it on their phone after the next update (their answer to gh377-no-repro). If it stays black, the cause is something else and this record is wrong.
