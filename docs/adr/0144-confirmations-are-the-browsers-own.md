# Confirmations are the browser's own

The owner asked on #52: "Why is there a fake little iOS style confirmation that pops up when I try to enable pull-in to do cards when idle? First of all, that shouldn't have a confirmation. Second of all, we should never ever make a fake native confirmation like that." This supersedes in part [0023](0023-a-card-can-be-held-and-every-card-button-confirms.md)'s labelled confirmations and [0051](0051-a-device-app-card-carries-an-install-link.md)'s install rebuild confirmation, which needed them.

- **No page imitates a native dialog.** `BoardDialogs.confirm(message)` in `board/public/dialogs.js` is the browser's `window.confirm` for every caller, and `notice` is `window.alert`. The `{ok, cancel}` labels and the bottom sheet (`.confirm-sheet`) are gone; a confirmation reads right without button labels, so a message ends with the action as a question ("Restart The Shop?"). The board view's abort signal still applies: a confirm already aborted answers false without asking.
- **Pull in Todo cards turns on with no confirmation**, as it turns off. Auto-merge's toggle keeps its confirm.
