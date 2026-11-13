# The UI tests assert behaviour, not CSS or copy

Card #623, split from T-254 (Findings 3). The owner chose "Loosen to behaviour" for tests that pin exact copy or CSS text.

board/ui.test.mjs and board/view.test.mjs broke on harmless edits: a recoloured rule, a reworded status line or a reordered span failed a test while the board still did the same thing. Their cost is upkeep, not speed.

What changed:

- **CSS is no longer read for its values.** The tests that only matched style.css or colors.css text are gone: dark mode's hex values, the key hint's colour rule, the typing rules for the + and the bottom bar, and the held card's colour. Tests that check what a card or line renders no longer end with a regex on its CSS rule. A colour now shows in a test as the class or tone the markup carries (`tone-ready`, `in-review`, `staged`), and style.css maps that class to a colour.
- **The guards stay:** every colour comes from shared/colors.css and the board's sheets define none of their own; no colour constant is named for a person or a hue, and every label on an accent fill reads `--on-accent`; every hub.css selector sits under `.hub-view`; a badge tone takes a shared colour; the rules editor takes colours only from colors.css; offline holds every sending button. These catch a class of mistake, not one value.
- **Board Settings is tested by table.** One `settingsPage` helper in view.test.mjs serves a fake board's settings, keeps each POST and answers a refusal. The Auto toggles (auto_build, auto_triage, auto_review, idle_notification) share one table: each saves at once with no confirmation, waits on its toggle, and puts it back on refusal. The parallel caps (implementers, planners, serves) share another: a whole number from 1 to 99 saves, anything else or a refusal puts the saved one back.
- **The card buttons that wait on a tap are tested by table.** Unhold, a Hold sheet chip, Done, a bump and Merge each wait on their button with the label kept and the card unchanged, and a refusal rests the button and toasts the server's reason. Each one except Merge spins until a board shows its change while its POST is still out. Merge's rest is the Merge race test's.
- **Copy is asserted as state.** Where a test pinned a saved status line word for word, it now checks what the line says something about: the number saved, that on and off read differently, that a refusal shows the server's reason. Where a test pinned a whole status-line div, it checks the line's classes and its mark. Try badges read their words from `tryWords`.

The old-URL tests stay separate: each one covers a different behaviour (the Hub row's selection, the board modal's guard, the hub modal's history, the dirty-rules guard on every dismissal).
