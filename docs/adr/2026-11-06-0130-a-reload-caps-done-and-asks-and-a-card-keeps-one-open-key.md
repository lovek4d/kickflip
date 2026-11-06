# A reload caps Done and Asks, and a card keeps one open key

A card open from before a reload no longer stays shown past Done's and Asks' cap of 10 (`state.restored`); only a card opened this visit, by a tap or a `#item=` link, does. Done and Asks therefore always load showing their newest 10.

A closed card sometimes reopened after a repaint: ui.js remembered open `<details>` by owner key plus summary text, a card's summary text changes as it ages, so closing it removed the wrong entry and a stale one reopened it later. A card is now remembered by its key alone.
