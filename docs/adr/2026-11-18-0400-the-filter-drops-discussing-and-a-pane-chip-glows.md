# The filter drops Discussing, and a pane chip glows while its filter is on

The board filter has four boxes: Ready, Action needed, Questions, Blocked. Discussing is out of the menu, so a
discussing card always shows unless another box hides it. The pane's Todo tally keeps its "n discussing" count with a
local matcher in app-pane.js; it is not a filter option.

A right-pane chip (need you, questions, ready) glows with a ring in its own tone while the board filter shows only its
box (app-lanes.js showsOnly). Tapping it again clears the filter and the glow. The header's filter button does not
pulse; it keeps its ordinary filtered mark. Reduced motion gets a steady ring, with no pulse.

The owner chose this over a pulse on the header button: "glow is on the right pane's pill, not the filter in the header".
