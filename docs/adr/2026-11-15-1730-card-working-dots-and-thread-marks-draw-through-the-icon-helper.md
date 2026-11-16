# Card working dots and thread marks draw through the icon helper

The owner asked for "one helper everywhere" ([one icon-and-text helper takes a shape and a colour](2026-11-14-2250-one-icon-and-text-helper-takes-a-shape-and-a-colour.md)). The cards' working dots (`.working-dot`, `.agent-dot` in `style.css`) and the thread status lines' marks (`ui.js` `mini` and `MARK_ICONS`, drawn by `statusMark`) were still hand-built.

**Marks.** Every `MARK_ICONS` icon is now a shape in `ui-icon-text.js` (eye, flame, image, retry, move, chat, code, flag, blocked, play, link, created, circle-check, reopen, reply, chevron, question, with the existing check, pause, arrow and warn), and `MARK_ICONS[words]` is `iconText(shape, 'current', '')`. The `mini` helper and the `.mark-icon` classes are gone; the fold's caret rotates `.it-i`.

**Working dots.** `BoardUI.WORKING_DOT` is the pulse shape and `AGENT_DOT` the still dot, both in `current`. The card lines, the thread's status lines, the New strip and the review card draw them; `recount` still keeps the first child, now the helper's span.

**`current` is a colour value beyond the six.** The lane colours, a planner's blue and a thread line's tone are set by a parent's class (`style.css`), so the dot and mark take the line's own colour instead of each call site passing one. The colour priority's six stay `ICON_COLOURS`; `current` is the only other value `iconText` accepts. A working dot with no colour set by its line is the orange of before (`.it-pulse.it-current`); the lines that set a colour make the dot `color: inherit`.

**Load order.** `ui.js` builds `MARK_ICONS` and the dots when it loads, so `ui-icon-text.js` loads before it (`app.html`, `prototype.html`, `progress-review.html`, which now links `sidebar.css` for the helper's rules).

The working dot is 8px now, not 7px, and its gap to the word stays the 5px it was.
