# A wait for a condition is a block; stall refuses one

`item stall` flags a task the orchestrator can't restart and lights the owner's Reply. T-773 waited on a quiet host and was stalled, asking the owner for action nobody could take. A wait for a condition is `item set --blocked-until`, which waits on nobody.

`item stall` now refuses a reason that names a wait (waiting, wait for/until/on, until, once the …) and points to `--blocked-until`. Its usage and SKILL.md say the same. The match is on words, so a real stall whose reason happens to use one must be reworded.
