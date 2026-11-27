# Scrollbars follow the theme

shared/colors.css declares `color-scheme` in both themes and styles every scroller thin, with a transparent track and a thumb mixed from --muted into --bg (stronger on hover).

Without `color-scheme`, the browser drew its own light scrollbars in dark mode: with a mouse plugged in, a white bar showed down the middle between the lanes and the right pane. The track is transparent so the pane's border-left stays the only divider. The rule lives in colors.css, not style.css, because the hub links only colors.css and its own CSS, and every scroller on the hub and every board should look alike. Overlay scrollbars (touch, trackpad) are unchanged.
