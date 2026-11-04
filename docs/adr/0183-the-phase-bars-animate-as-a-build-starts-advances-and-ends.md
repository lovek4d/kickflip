# The phase bars animate as a build starts, advances and ends

The owner chose take B of prototype `phase-anim` on #106: the five bars fill in one by one.

- **Start.** The " · " fades in and the bars grow in from their left edges, left to right, 40 ms apart. **End.** The bars shrink away right to left, then the dot. **Advance.** The new phase's bar sweeps full from its left edge.
- **Detected by comparing redraws.** The board redraws cards from fresh data, so `board/public/app-cards.js` keeps each card's last drawn phase by key and `BoardUI.phaseMotion` (`ui-cards.js`) names the change: enter, fill, leave, or nothing for an unchanged phase. The first draw of a page only records phases, so a loaded board stays still. A leaving strip is cloned from the old DOM before the redraw and animated at the end of the new time row, since the redrawn card no longer has it.
- **No motion under prefers-reduced-motion: reduce.**
