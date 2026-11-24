# Hovering a task link shows its title

Status: accepted

A task link (any `<a>` to `#selectedCard=<key>`, drawn by `ui-links.js`) shows that task's title in a one-line popup when
the owner hovers it with a fine, hovering pointer (`app-link-hover.js`).

- The owner chose title only over a mini header (ref, chips, PR, flags) and over the header plus the latest thread line,
  and asked to start simple.
- The title comes from the items the page already holds, so there is no request; a task the page doesn't hold shows
  nothing.
- It opens through `popup.js` after 300 ms, closes when the pointer leaves the link, on scroll and on Escape, and takes
  no pointer, so the link's click opens the task as before. Nothing shows on touch.
- The title ellipsises at 48ch.
