# The questions sheet is opened by buttons and makes no history

A card's Questions button and a thread's questions line were links to the ? page (`questions.html#…`) that the board turned into the questions sheet (app-questions-sheet.js). The sheet, the cards' taps, the pane's selection and the router all heard the same tap, and the sheet pushed a history entry of its own. Wide, the sheet flashed and the page took over; on a phone, closing it went back onto the ? page with no topic.

The sheet is separate from the page, as the notes sheet is over the questions pane: both entries are now buttons (`button[data-questions]`) with no href, so the router never sees them, and the sheet pushes and spends no history entry. Its ✕, Escape, the dim area and a swipe down close it, and the board is as it was. The ? in the header still opens the Waiting on you page.

The sheet's content (`.qs-body`) takes no padding of its own: the sheet's form already pads it, and the two together squeezed the cards into a wide margin.

An earlier try made the sheet listen in the capture phase to win over the router; the owner rejected it, as the sheet should not arbitrate with the page at all.
