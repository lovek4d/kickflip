# One icon-and-text helper takes a shape and a colour

Every status dot and word was built by hand: the sidebar's `word(tone, text)` in `hub/home.mjs` statusLine and again in `ui-sidebar.js`, each with its own `t-<tone>` classes. A stale sidebar row wrapped its line in `<span class="held">`, which lost the flex gap between dot and word and broke the chips' order until it was made `display: contents`, and `ui-sidebar.js` rewrote that HTML with a regex to put "paused" in place of a board's word. The owner asked for "a single icon + text helper to create these everywhere", and for its enum to be "kind dot/check/etc. a separate param for color? With choice of enum red orange blue gray?". Shown three takes, they picked "Dot 8px, gap 6px, icon and word same colour".

**`BoardUI.iconText(shape, colour, text, {label})`** (`board/public/ui-icon-text.js`) is the one helper. Two enums:
- `ICON_SHAPES`: dot, pulse (a dot that beats on every pulse's one clock), check, x, spinner, pause, arrow, clock, warn. The shape fixes the icon, its size (an 8px dot, a 12px glyph) and the 6px gap to the word, on the helper's own inline-flex box, so it needs no flex parent.
- `ICON_COLOURS`: red, orange, blue, green, purple, grey, the colour priority's set (AGENTS.md). The colour colours the icon and the word alike, and nothing else.

A shape or colour outside its enum throws. `label` gives the icon `role="img"` and an `aria-label` for an icon that means something without the word; otherwise it is `aria-hidden`. `sidebar.css` draws `.it`, since every page that runs the helper today carries the sidebar.

**The sidebar's status is data.** `sidebar.json`'s `sub` is `{status: {shape, colour, word} | null, stale, chips}` (`home.mjs` statusLine), and `ui-sidebar.js` draws it: the chips, the icon and word, and "(stale)" in one `.sb-status` flex line. A stale line draws its icon and word grey with the pulse stilled and its chips grey. A pause swaps the status for a grey "paused" unless the status is red, read from the data, so the strip regex and the `.held` wrapper are gone. The Hub row maps `hubHealth`'s tones to colours (`HUB_COLOURS`), and "Notifications off" or blocked reads red: notifications that can't reach the owner are theirs to fix now.

The sidebar keeps its dots: a pulse for working, a dot for every other status. The other shapes are there for the hub links, Connecting steps and the tickets status (T-367) and the cards' working dots and thread marks (T-368), which move onto the same helper.
