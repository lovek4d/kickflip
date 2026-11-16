# A question's suggestion names its task

Follows [overnight triage suggests your earlier answers](2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md), whose field this renames (#908).

- **The field is `task`.** A question carries `suggested {option, task, answer, reason?}`. Task is the domain word (CONTEXT.md); the CLI help and SKILL.md already said it, while the code took `card` (owner, 11/16).
- **One migration, no dual reading.** The start-up strip (`stripDeadFields`) rewrites a stored `suggested.card` to `task` in owner.json and the archive. `question add` refuses `card`.
