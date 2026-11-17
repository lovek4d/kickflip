# A sent answer clears its card's questions marks at once

A card's Open items word, its Questions button's orange and the pane's questions count came from the board's next snapshot, so they lagged behind a Send.

The browser now lays the answer outbox over the snapshot (ui-snapshot.js `answered`, drawn by app.js beside `tapped`). When every open question of a card has an answer set in the outbox that has not failed, the card draws as answered: no action of the questions or pick kind, the button not resolving, its open count moved to answered. This lasts until the snapshot shows the answers. A failed set drops the overlay and the card reads as the board has it. A card with a question no set answers is untouched.

The card's action under the dropped one is not recomputed in the browser; the card shows none until the board replies.
