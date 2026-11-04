# Site icons are line icons from a built-in set

Each site's row in the sidebar ([a sidebar of every board replaces the hub home](2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md)) and on the hub's page shows a line icon from the set in `hub/icons.mjs`, in the [icons are SF Symbol-style line icons](2026-10-29-1639-icons-are-sf-symbol-style-line-icons.md) style: a 24-unit view box, `stroke="currentColor"`, stroke width 2, round caps and joins, no fill. The icon sits on a soft tile, an 18% tint of the site's color, and is drawn in that color.

A manifest entry's `icon` names a key in the set, such as `phone` or `book`, and `web-ts join` and `web-ts set` accept only those keys. Without a key, or with any other value such as an emoji from before this choice, the hub matches words in the route and title against a small keyword list, so `ios-orchestrator` gets the phone, `backend-audit` the checked magnifier and a course the book. When no word matches, the tile shows the title's first letter.

Considered options:
- Emoji, as before. They draw in each platform's own colorful style, so they clash with the board's flat look.
- An icon font or SF Symbols. A font needs another request, and Apple licenses SF Symbols only for native apps on its platforms (see [icons are SF Symbol-style line icons](2026-10-29-1639-icons-are-sf-symbol-style-line-icons.md)).
- Only an explicit key, with no keyword guess. Every existing site would fall back to a letter until its session set a key.

The owner asked for flatter icons that fit each session ("I'm sure a flat phone icon exists") and picked take C, One quiet list, of the hub prototypes in the board's style (ask on 2026-10-23).
