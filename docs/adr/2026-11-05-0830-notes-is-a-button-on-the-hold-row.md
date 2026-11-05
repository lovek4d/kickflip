# Notes is a button on the Hold row

A card's **Notes** open from a button, the rightmost on the workflow row with Hold/Unhold, styled like its neighbours. It replaces the Notes link in the Links line ([notes was a link in the details list](2026-10-30-1626-notes-is-a-link-in-the-details-list.md)), which is gone. The button is an `<a class="button" href="notes.html?item=<key>">`, so the reader sheet's click handler opens it in the sheet as before; a card with no notes has no button. Links keeps Install, GitHub and the rest.

The owner (11/05): "I think notes should become a button, perhaps the rightmost button, on the same row as held, instead of a link."
