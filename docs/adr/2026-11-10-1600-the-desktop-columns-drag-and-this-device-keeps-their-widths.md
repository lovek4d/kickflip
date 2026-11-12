# The desktop columns drag, and this device keeps their widths

From 900px the board has three columns: the sidebar rail, the lanes and the Waiting on you pane. Two edges drag: the sidebar's right edge and the seam between the lanes and the pane (`board/public/col-resize.js`). The phone layout has no handles.

- The handle is a hairline that thickens on hover or focus (the owner's pick from the prototype round).
- Widths are kept per device in localStorage (`hub:sidebarWidth`, `hub:paneWidth`), one set for every board, and set on `<html>` as `--sb-w` and `--pane-w`. Unset, the stylesheet's defaults hold: a 272px rail and half and half.
- Clamps: sidebar 220–420px; the lanes and the pane each 360px or more. A window too narrow for both keeps the pane at 360px. A stored width is clamped again on every resize, without being rewritten.
- A double-click on a handle forgets its width; ←/→ on a focused handle moves it 16px.
- Everything keyed to the old widths reads the variables: `--sidebar-w` (body padding, the widened pane's left edge) and the board's + (`--pane-w` or the old midpoint).

Superseded in part by [the board has no Needs you deck or pane](2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md): the lanes | pane seam, `--pane-w` and `hub:paneWidth` are gone; the sidebar's edge still drags.

Restored by [the desktop pane is back without the Needs you deck](2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md): the lanes | pane seam, `--pane-w` and `hub:paneWidth` are back.
