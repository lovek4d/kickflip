# A starting board's row draws an icon for its step

The new-board row showed the plus while the board started. It now draws one icon per start step, in the accent colour: a download arrow while cloning, a terminal prompt while starting the orchestrator, and a skateboard while landing it. The owner picked an icon per step over one git-pull icon for the whole start (#221, on the prototype start-icons-2), and the skateboard over the flag, a kickflipping board, a check and a rocket.

The icon comes straight from the step (`ICONS[s.step]` in `board/public/ui-sidebar.js`), with no fallback to the cloning icon, so the row never flashes back to the download arrow at the end of landing: when the board joins, the starting row is replaced by the board's own row and its permanent icon. The New board row and a failed start keep the plus.

No open icon set (Lucide, Tabler) has a skateboard, so its deck-and-wheels glyph is drawn inline in `ICONS`.
