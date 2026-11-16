# Queued planners are keyed by card and kind

`data/queued-planners.json` keys a waiting agent as `<card>#<kind>`, so a reviewer, a grill, a prototype or a visual agent queued on one card each keep their own entry and all launch when the hold lifts. Keyed by card alone, the second one queued replaced the first and the first never ran. A second agent of the same kind on a card still replaces the first. An entry written before this change, keyed by the card alone, still launches and still marks the card paused.
