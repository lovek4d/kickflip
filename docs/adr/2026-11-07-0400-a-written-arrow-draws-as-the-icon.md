# A ↗ written in owner-facing text draws as the arrow icon

Planners and the orchestrator write ↗ as text in question fields, and iOS Safari can draw it as an emoji tile even with U+FE0E. `escText` in `board/public/ui.js` escapes text like `esc` and swaps each ↗ (with or without U+FE0E) for `LINK_ARROW`. `linkText` (so question, context, thread lines and notes) and option labels, details and the answered choice use it. `esc` stays as is: it also escapes attributes, where an SVG would break the markup.
