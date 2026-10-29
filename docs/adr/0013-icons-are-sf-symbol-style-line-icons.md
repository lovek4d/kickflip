# Icons are SF Symbol-style line icons

Header and row actions on board pages are icon buttons, drawn as inline SVG line icons in the SF Symbols style: a 24-unit view box, `stroke="currentColor"`, stroke width 2, round caps and joins, no fill except to mark an "on" state. Each button carries an `aria-label` and a matching `title`.

A state change swaps the icon, not the word.

Icons are inline, not an icon font or a sprite file, so a page works offline from the Mac with no extra request. SF Symbols themselves can't be used: Apple licenses them only for Apple platforms' native apps.

The owner asked for this style "in general" with the Improvements bulb (ask on 2026-10-23), which has since gone ([0041](0041-hub-changes-come-as-asks-not-improvement-rounds.md)).
