# An offline board disables its buttons and keeps their text

Status: accepted (#399)

While the board can't be reached, every button that sends stays at its normal label and size, greyed and stopped (style.css `.offline`, ui.js `SENDS`). The earlier " · Waits for the board" suffix made them huge and is gone.

A tap on a held button goes nowhere and shows the toast "Waiting for the board to reconnect" (`holdSends`' `onHeld`). The buttons are not `disabled`, so the tap still reaches the capturing handler. When the board is back they act again with no other change.

#220 (saving offline taps to send later) must not undo this: offline, the sending buttons are held, and nothing is queued from them.
