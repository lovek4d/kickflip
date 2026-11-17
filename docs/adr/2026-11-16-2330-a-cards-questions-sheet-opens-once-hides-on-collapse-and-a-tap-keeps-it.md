# A card's questions sheet opens once, hides on collapse, and a tap keeps it

Refines [the follow-the-card sheet](2026-11-16-0600-on-desktop-the-questions-sheet-follows-the-opened-card-unless-opened-by-hand.md).

- Opening a card whose questions sheet is already open leaves the sheet alone: no reopen, redraw or reset. A card tap marks the card's topic in the pane, which used to close the sheet before followCard opened it again; the pane now leaves the sheet open when it marks that sheet's own topic.
- Collapsing a card closes its questions sheet when the sheet is autoOpen and shows that card. A sheet the owner opened, or one showing another card, stays.
- Questions (or any way into the questions that isn't a card tap) on a sheet already open for that topic sets autoOpen false, so it stays when another card opens and on collapse.
