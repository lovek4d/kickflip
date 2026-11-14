# item add links a new task with --before or --after

T-265 waited on T-337 for an hour with the wait said only in prose. A fix filed for a stuck task now links itself.

`item add` takes `--before <task>` and `--after <task>`, each a comma list:

- `--before T-N`: the new task must be done first, so T-N gains it as a dep, in the same write as the new task. Each side reads a thread line ("Blocked by" on T-N, "Unblocks" on the new task).
- `--after T-N`: the new task waits on T-N. This replaces `--deps` on `item add`, with the same lines.
- Neither: no link.

Deps stay the stored blocked-by list; `item set --deps` edits it as before.

A faulted land no longer holds the orchestrator's wait once the task is blocked: a block on the task is its land step, and the wait's words name `item add --before` for the fix.
