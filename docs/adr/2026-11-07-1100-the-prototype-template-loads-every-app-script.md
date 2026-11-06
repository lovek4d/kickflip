# The prototype template loads every script app.html does

A take is built from the board's real renderers, and a renderer the page didn't load (ui-threads.js, ui-markdown.js
and the rest) threw as soon as a take drew a thread or review text. The template, board/public/prototype.html, now
lists every script in app.html, in app.html's order, before the switcher and the kit. board/prototype-kit.test.mjs
compares the two lists, so a script added to app.html is loaded by the prototype page too.

Owner's answer on the prototype round (gh353b-proto): every app.html script, in its order; the alternative was
ui-threads.js alone.
