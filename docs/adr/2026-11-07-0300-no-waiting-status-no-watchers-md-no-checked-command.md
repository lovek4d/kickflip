# No waiting status, no watchers.md, no checked command

From the skill audit (#180), owner's answers on #238 (11/06).

- **`waiting` is no status.** Every reader already treated it as no status, and blocked-by (`deps`) does all the blocking. `ITEM_STATUSES` drops it, `item set --status waiting` is refused like `planned`, `item add --deps` leaves the status unset, and the board's start-up migration (`dropPlannedStatus`) clears it from existing cards. This replaces the SKILL.md sentence "Never park built work as `waiting`", which nothing enforced.
- **No `watchers.md`.** Nothing read it: the hub's resume prompt names the session id and reruns the join and watch steps. "A rejoin keeps the label, model and folder it leaves out" moved into the join step.
- **No `checked` command.** The hub's poll writes `data/checked.json` for every board and flushes the push queue after every check. Queued pushes (Ready, Merge, a session's `push` without `--now`) now arrive at the hub's next check, at most a minute away while the owner is present and five while away, instead of at a tick's end. Amends the Queued bullet of [pushes go by kind and each arrives on its own](2026-10-29-1639-pushes-go-by-kind-and-each-arrives-on-its-own.md).
