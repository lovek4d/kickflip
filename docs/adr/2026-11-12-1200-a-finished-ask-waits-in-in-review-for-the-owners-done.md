# A finished ask waits in In Review for the owner's Done

The owner (card #582) wanted a finished ask card, such as a question, a release or a fold, to wait for their Done instead of going straight to Done. Their later note chose In Review, since it is where a card waits on the owner's Done, and the card's ask marker (`from_ask`) to tell such a card.

- **The orchestrator's `item set <card> --done --text <t>`** on a card an ask became (`from_ask`) that no build ran on (no builder record, no branch, PR, pushed branch or held Merge) moves it to In Review with T-187's close mark (`waits_on_owner {on: close}`), and `--text` becomes its thread line. It closes no ticket and resolves no question.
- **Only the owner's Done** moves it to Done and closes its ticket; the tap clears the mark.
- **Every other close keeps today's path.** A card a build landed (land, a verified `builder done`), a card no ask became, `--split-into`, a merge and the board's own closes go to Done.
- **What it shows.** The card reads Action needed (`close`, "Tap Done") in In Review, with no phase and no builder. It has no agent record, so it takes no implementer slot and the pull never counts it.
- **Amends** [reply --close marks a card waiting to be closed](2026-11-12-0800-reply-close-marks-a-card-waiting-to-be-closed.md): a Todo card that `reply --close` marks still stays in Todo, but a card the orchestrator finishes is In Review, not Todo.
- **An owner message** on such a card clears the mark as on any marked card; the card stays In Review for the orchestrator to answer.
