# The Send bar page pads only the nav under it

On a phone the Waiting on you page's `main` kept the shell's 96px + nav + safe-area bottom padding, because
`body.has-sidebar > :not(.sidebar) > main` outranks `body .view-questions main`; about 149px of dead space sat under Send.
The page's rule is now `body .view-questions.view-questions main`, which ties that selector and comes later, so `main` pads
only `--app-bottom` and the page ends snug under the Send bar. board/send-bar-snug.test.mjs measures it in Chrome at 390px
and 1280px. Follows 2026-11-02 #343's intent, which the specificity had left undone on a phone.
