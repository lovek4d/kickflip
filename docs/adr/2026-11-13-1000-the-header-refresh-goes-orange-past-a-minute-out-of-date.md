# The header refresh goes orange past a minute out of date

Status: accepted (owner, card #639). Amends 2026-11-12-1000-the-logo-dot-carries-the-hub-state.md, which left the header's time and refresh arrow never coloured.

The header's time and refresh arrow turn orange once the page's data (`state.fresh.at`) is more than 60 s old, and stay plain otherwise. Nothing else colours them: the logo's dot still carries the hub's state, and a pause, a busy host or a lost link only move the time's title. The `.hold` mark no longer colours the arrow.

`statusLine` puts `late` on the time's span past 60 s; style.css colours the span and, through `.refresh:has(.late)`, the arrow. The header's existing 15 s tick re-renders it.
