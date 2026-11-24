# One Escape closes the top sheet, and each sheet takes focus

A sheet opened from another stacks on it (2026-11-17-0306). Escape used to be answered by each sheet: its native
`cancel`, or its own document keydown guarded by `isTopSheet`. After `restack` closed and showed sheets again, focus could
sit in a sheet no longer on top, so the wrong one could answer.

Now ui.js holds one capture `keydown` on the document. Escape, with a sheet open, no popup open (`:popover-open`) and
the key not aimed at a dialog outside the stack (a confirm above it; focus left in a lower sheet still routes to the top), is kept from the browser and sent to the top sheet as
a `cancel` event, which every sheet's own close path already answers (the reader pops a page first). A sheet with no
cancel handler closes through `closeSheet`. The per-sheet Escape handlers in the reader and the questions sheet are gone.

`restack` ends by focusing the top sheet: its `[autofocus]` element, else the sheet itself (tabindex -1), with
`preventScroll`; focus already inside it stays. So each Escape reaches the sheet the owner sees on top.
