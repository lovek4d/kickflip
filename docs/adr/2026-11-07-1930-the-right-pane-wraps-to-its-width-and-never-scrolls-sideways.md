# The right pane wraps to its width and never scrolls sideways

The desktop right pane's `overflow-y: auto` made its `overflow-x` compute to `auto` too, so a long unbroken title or link, a code line or a no-wrap button row scrolled it sideways (#414). The pane now sets `overflow-x: hidden`, and its content wraps instead of overflowing: every descendant takes `min-width: 0` and `overflow-wrap: anywhere`, code and `pre` wrap, and button rows wrap. The owner chose wrapping over clipping. The prototype viewer #429 puts in this pane inherits it.

This amends [the split view's right pane contains its scroll](2026-11-06-0000-the-split-views-right-pane-contains-its-scroll.md): the pane scrolls up and down only.
