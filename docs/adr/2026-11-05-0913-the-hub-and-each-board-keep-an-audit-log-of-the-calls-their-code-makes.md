# The hub and each board keep an audit log of the calls their code makes

Follows `2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md`: builder pick's choice and reason
showed only in the CLI print, and the builder record kept the kind and model but not why. The owner's answers on #121
(gh121-scope, -store, -shows, -inputs, -keep, all A).

`shared/audit.mjs` appends one JSON line per call the code makes on its own:
`{at, call, key?, result, reason, inputs}`, where `inputs` is what the call read to decide.

- **Where.** A board's calls go in `<site>/data/audit.jsonl`, whichever process makes them: its server, its CLI, or the
  hub acting on that board. The hub's calls that belong to no one board go in `~/.claude/kickflip/audit.jsonl`.
- **What.** On a board: `builder-pick` (a build starting, with what the pick read: Codex's status, the Codex share, the
  pause line and Codex's usage, the hub's Claude model, the card's size and model, any `--model`, and the dispatch),
  `pull`, `released-start`, `launch-held`, `arrival-planner`, `relaunch`, `lander`, `triage`, `pr-review`, `push`
  (the server's own pushes, and the hub's push when a resumed session didn't come back), `pick-up`, `auto-merge`,
  `ready-draft`, `session-resume` and `compact`. In the hub's log: `usage-pause`, `usage-resume` and `linear-move`.
  Housekeeping that decides nothing is left out: the Done archive, migrations, the morning `check-github` wake, try
  rebuilds and fetches, prompt expiry.
- **Pick.** The pick is logged where a build starts on it (`store.mjs startBuilder`), not on `builder pick`, which only
  asks. A start taking up a dispatched record logs nothing: the dispatch's start logged its pick.
- **Retries.** A call retried on every check until something changes (a merge GitHub refuses, a gh or Linear failure)
  passes `once`, so it is logged when its outcome changes rather than every poll.
- **Keep.** An append whose log's first entry is older than 30 days rewrites the log without the old entries; a read
  skips them too. A line a crash cut short is skipped on read.
- **Read.** CLI only: `board.mjs --site <route> audit [<wave/id>]` and `kickflip audit` print each entry as
  `<at> <call> [<key>]: <result>. <reason>` and its inputs. A page view would start with an in-situ prototype.
