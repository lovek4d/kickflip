# Expanding in a thread grows it upward

Opening or closing a fold in a thread (a run of status lines, a fault's detail, a long output) and tapping Show more
change the thread's height above its reply form. Each now runs through app-core.js `holdBelow`, which scrolls the page by
however far the reply form moved, so the form and the messages below the change stay where they were on screen and the
page above takes the height. The anchor is the thread's own reply form, one node that survives a repaint and sits below
every message, so no per-message lookup is needed. A link inside a fold's summary still follows its href.
