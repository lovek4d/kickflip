# A send button's press keeps the text box focused, so a tap with the keyboard up sends

On a phone, a tap on Reply with the keyboard up only closed the keyboard. The press moved focus off the box, the
keyboard started closing (`:root.typing` drops on focusout and `fitSheet` measures `--kb` again), and the send bar,
which rides on the keyboard (2026-11-05-1834), slid out from under the finger before the click landed.

`attach.js` now cancels the mousedown on a composer's submit buttons and on its eye, fire and image buttons, as it
already did for the paperclip (2026-11-12-0010). Focus stays in the box, the click lands, and the click's handler
closes the keyboard once it sends: `post()` in `app-threads.js` and the New task sheet's submit in `new-task.js` blur
the box, and the edit box's Save closes its editor. Hold, Resume, Done and Reopen open their confirm, which takes
focus. Every composer (`[data-composer]`) gets it, since `attach.js` already wires them all.

It is the mousedown that is cancelled, not the pointerdown: cancelling a pointerdown doesn't stop the focus move.

The "What's left?" chip is left out: it sends without blurring the box, so keeping focus would leave the keyboard up
after it sends.

Not confirmed on a phone: the cause is read from the code; the owner checks it on the phone after landing.
