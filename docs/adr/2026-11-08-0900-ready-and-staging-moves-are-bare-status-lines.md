# Ready and staging moves are bare status lines

A card newly moving to staging (the owner's answers, an Implement with text, a bare Implement, a Reply on a ready card) writes a gray "Marked as staging" status line in its thread, in place of the old Claude bubbles ("Staging: …", "Back to staging: …"). The orchestrator's `item set --state ready` from a state other than ready writes a green "Marked as ready" line. Both are `command` lines (`staged`, `readied`) with an icon each in ui.js `MARK_ICONS`, and neither carries the reason: the notes hold that.

A bare Implement reads "Implementation requested", then "Marked as staging", then waits for the orchestrator's review, then "Marked as ready", then the build. It no longer readies the card and starts the build itself, because the owner wants every Implement reviewed before it builds.

Decided by the owner on #390 (take C of the prototype: bare lines, "Marked as ready" in green).
