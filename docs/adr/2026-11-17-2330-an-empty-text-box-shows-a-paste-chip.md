# An empty text box shows a Paste chip

A composer's text box (`BoardUI.dropZone`) carries a Paste chip at its bottom left. style.css shows it only while the
box's placeholder shows, so it is gone once there is text, and boxes with no placeholder never show it.

A tap reads the clipboard at once, with no confirm of the board's own (on iOS Safari the browser shows its own Paste
bubble). Text goes in at the cursor and fires `input`, so drafts save; an image or file attaches through attach.js.
An empty clipboard toasts "Clipboard is empty."; a refused read toasts "Clipboard access denied.". attach.js raises
these as a bubbling `attach-notice` event, which app.js turns into a toast, since attach.js has no toast of its own.

The chip lives in `dropZone`, so every composer gets it (New task, thread reply, question note), not only the two the
owner named; the placeholder rule keeps it off the edit box.
