# Every task reference links and shows its lane ring

Extends 2026-11-12-0820-a-card-link-ends-with-its-lane-ring.md from text refs to every place the board draws one.

Every reference to a task the board knows is a link to its card that ends with the card's lane ring. The one exception is
a task's own badge in its header (owner, T-238). `taskLink` in ui-links.js is the only place that builds such an anchor:
the ref in text, the card footer's "blocked by" and "waits on", the open card's Parent, Children, Related to, Blocked by
and Waits on it rows, the Done list, the New strip's "Ticket created" and "Added to" lines and the architecture review's
last card all call it.

A card's link to another card (`parent`, `children`, `related`, `blockedBy`, `waitsOnIt` in domain.mjs) carries the
linked card's `lane`, so a renderer needs no lookup of its own. `blockedBy` and `parent` take it after every lane is
settled (`linkCards`).

The rule is a test: ui.test.mjs renders the footer and the open card with blocked, related and parent tasks and fails on
any task anchor with no ring.
