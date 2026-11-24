# A topic pill tap keeps the page scroll

On the Waiting on you page, tapping a topic pill re-renders the list and keeps the window's scroll position (`const y = scrollY; render(); scroll(y)`, the pattern `repaint` uses). `scrollTo` clamps to the new page's bottom, so the page moves only when the new topic is too short to stay where it was. The desktop split pane already kept its scrollTop.

The move on after a Send still jumps to the top: the owner asked for pill taps only (#529).

A question link no longer jumps to the top (#1195): `scrollToFocus` does nothing when the card's title row is already on screen, as a tapped card's always is. A card off screen (a search pick, a glance row, a card link in a thread, a first load with URL params) still scrolls into view.
