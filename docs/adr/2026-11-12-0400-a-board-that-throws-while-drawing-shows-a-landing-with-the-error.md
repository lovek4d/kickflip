# A board that throws while drawing shows a landing with the error, not offline

A board that loaded but threw inside `render` used to reach `loadBoard`'s catch, which read it as out of reach: the header
turned offline and "Board offline" appeared, though the host was fine and the data was good.

`land` now guards its `render`. A throw goes to `console.error` and shows the draw landing (`BoardUI.drawLanding`, in
`#downLanding`, `data-down="draw"`) in the board's place: the error's name and message, Reload (reloads the page), Copy
error and Show details (the stack). The link stays online, since `land` has already marked it up. `land` returns true, so
`send` and `boardAfter` treat the board as landed and a tap's draw failure shows no "Is the host awake?" toast. The next
board that draws clean clears the landing, as it clears the offline one. The first copy paint catches its own throw with
`console.error`, and the first load still runs.

The landing carries no "reported to the board server" line until the report itself exists.
