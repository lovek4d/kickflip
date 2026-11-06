# Every owner-facing text path uses escText

Follows `2026-11-07-0400-a-written-arrow-draws-as-the-icon.md`. Card, wave and review titles, a card's details lines (next, refusal, rebase failure, ETA, owner check, Wave row), thread lines, the Needs you list and deck, and the Tailscale link in Board settings now draw ↗ as `LINK_ARROW`. Attributes keep `esc`.

Left as text: push notification bodies are plain text, not HTML, so there is nothing to swap an SVG into. Hub pages (`hub/*.mjs`) draw only site titles and fixed copy through their own `esc`, and are not changed here.
