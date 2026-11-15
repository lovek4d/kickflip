# Text to the owner names a question's task, not its id

Card #807. A session told the owner to "answer t461-audit"; the owner filed an ask, "t461-audit is useless to me, what does this mean?" A question's id is internal: the owner sees a question by its words, on its task's thread or the ? page.

## Decision

- **The commands that write text the owner reads refuse text naming a question's id**: `thread` (from claude), `reply` (--text or --file), `item set --text`, `item add --text`, `item triage --text`, `builder answer --text`, and `push` (--title, --body). The refusal says to name the task instead, e.g. "the question on T-461", and to quote the question's words if needed.
- **Every question the board holds counts**, in owner.json (open or resolved) and in the done archive. An id matches as a whole token, so "t9-auditor" does not name "t9-audit".
- **Ids stay valid as CLI arguments and in notes files**: `question resolve <id>`, `question move` and `item notes` are not checked.
- SKILL.md tells the orchestrator to refer to a question by its task.

## Consequences

An id that is also a common word would refuse text that uses the word; the board's ids are descriptive slugs, so it does not happen in practice.
