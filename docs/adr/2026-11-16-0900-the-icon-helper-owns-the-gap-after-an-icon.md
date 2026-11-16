# The icon helper owns the gap after an icon

A status dot sat flush against its word wherever its line was plain inline. The helper drew `<span class="it it-current"><span class="it-i it-pulse">`, and the 5px rule, `.it-pulse.it-current { margin-right: 5px }`, named two classes that sit on different elements, so it matched nothing. The gap came only from each place's own container: a flex line with a gap looked right, an inline line got none.

**Now the helper's CSS (`sidebar.css`) makes the gap, once.** `.it` has `gap: 5px` between an icon and the word inside it, and `.it:where(:not(:has(.it-w)))`, an icon with no word of its own (a working dot, a still dot, a thread mark), has `margin-right: 5px` to the word that follows it in the line. A `.mark` keeps its own box and sets that margin to auto, so a mark's icon alone has none. The per-place `margin-right` rules in `style.css` are gone.

The gap is 5px, not the 6px of [one icon-and-text helper](2026-11-14-2250-one-icon-and-text-helper-takes-a-shape-and-a-colour.md): 5px is what the card dots had before the helper, so one value now serves both the helper's own word and the dots drawn alone.

`icon-gap.test.mjs` draws every dot in every colour, with its word inside and as a following sibling, in a plain inline line, and checks the measured gap is 5px.
