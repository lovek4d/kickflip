# Phone headers sit at the bottom, with boards nearest the thumb

The sidebar puts Hub first, then Turn on notifications when this device needs it, then Pages, then Boards with New board last. Both the drawer and desktop rail use this order. Boards have their own label; the sidebar header reads Kickflip.

- **Below 900px both headers sit at the bottom.** Every app-shell view uses a bottom bar for its page header: the title, its refresh and Settings controls when present, and the kickflip logo that opens the drawer. A page with a back arrow keeps it beside a phone-only logo. Framed pages use the same header and styles, whether the shell draws it or the page draws its own.
- **The drawer header sits below New board.** The drawer still opens from the left and closes with its logo, ✕, the scrim, Escape or a swipe back. Its header stays visible while the list scrolls. Opening the drawer shows the list's bottom; a live repaint preserves the list's scroll position. With space to spare, Boards sit at the list's foot.
- **From 900px headers stay at the top.** The rail uses the same flipped order, with its Kickflip header above the list. Its logo still collapses it, and the page's logo restores it. The device remembers that choice.
- **The bottom bar reserves space.** Its safe-area padding respects `safe-area-inset-bottom`; page content, framed content, sheets, toasts, the + button and the prototype switcher pill keep clear of it. The shared layout offset is `--app-bottom`. `dialogs.js` `fitSheet` still measures the visual viewport and keyboard independently; a keyboard taller than the bar replaces that bar's sheet clearance, rather than adding to it.
- **The logo carries no count.** Waiting counts remain in site status lines and the app badge; the logo's accessible label can describe what waits elsewhere.

The owner picked take B, “Both headers down”, in `prototype-sidebar-flip.html` (`sidebar-flip`, 2026-10-31). Board switching belongs within a phone thumb's reach; Hub and Settings are used less often. This changes the shared header and the space reserved by every view and overlay, so a header move must change those consumers together. This supersedes [0050](0050-a-sidebar-of-every-board-replaces-the-hub-home.md) on order, title and breakpoint, and [0048](0048-a-questions-takes-show-inline.md) on the back arrow's phone position.

Considered:
- Flipping only the sidebar and keeping both headers at the top (take A): board switching still starts with a reach to the top.
- Flipping only the phone drawer and keeping the desktop rail's previous order (take C): two orders to remember when changing widths.
- Opening the drawer from the bottom: the picked prototype keeps the left-edge drawer and its swipe gestures.

[0074](0074-hub-settings-expand-in-place-and-board-settings-open-in-a-modal.md) removes the Settings sidebar row and puts hub settings below Hub’s status. The board settings modal is centred at every width and keeps clear of the bottom bar through `--app-bottom`.
