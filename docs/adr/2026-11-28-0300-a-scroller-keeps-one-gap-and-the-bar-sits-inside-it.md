# A scroller keeps one gap, and its scrollbar sits inside the right one

The board's scroller (main, and the right pane) takes one gap, `--edge` (16px), on its top, left and right. The first lane or banner sits that far below the header, because lanes carry their spacing as a bottom margin (not a top one) and the sticky search bar's offset is the negative of that gap, so it sits flush at the top.

`scrollbar-width: thin` still reserves a classic bar's width (11px in Chrome), and no CSS stops that. The head script in app.html measures the bar into `--scrollbar-w`, and the scroller's right padding is `max(0px, var(--edge) - var(--scrollbar-w))`, so bar plus padding fill the right gap. An overlay bar measures 0 and changes nothing. The phone layout keeps its safe-area top.
