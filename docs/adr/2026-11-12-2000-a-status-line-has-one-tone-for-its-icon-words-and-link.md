# A status line has one tone for its icon, words and link

A thread status line's icon is `currentColor`, but a linked line's words took the page's link blue, so a grey Related line, a grey move line or a red fault with a link showed two colours.

`ui-threads.js` `tone` gives each request or board line one class by the colour rule (fault red > staged orange > readied green > created blue > grey), and `.status-line a { color: inherit }` makes the link follow it. Icon, words and link are one colour.

Both Created lines (`Created ticket`, `Created from`) and the board's `ticket-made` line use one plus-in-a-square icon, so created (blue) and related (grey) differ in icon as well as colour.
