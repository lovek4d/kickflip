# A topic pill tap keeps the page scroll

On the Waiting on you page, tapping a topic pill re-renders the list and keeps the window's scroll position (`const y = scrollY; render(); scroll(y)`, the pattern `repaint` uses). `scrollTo` clamps to the new page's bottom, so the page moves only when the new topic is too short to stay where it was. The desktop split pane already kept its scrollTop.

The move on after a Send and the hashchange for a question link still jump to the top: the owner asked for pill taps only (#529).
