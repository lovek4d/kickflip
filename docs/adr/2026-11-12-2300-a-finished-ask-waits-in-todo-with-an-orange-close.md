# A finished ask waits in Todo with an orange Close

Supersedes [a finished ask waits in In Review for the owner's Done](2026-11-12-1200-a-finished-ask-waits-in-in-review-for-the-owners-done.md).

The owner (card #602) kept Close where it is: nothing landed for an ask, so it is not truly done, and the card waits in Todo for the owner's Close. In Review holds only built work: a PR, or a landed build waiting on the owner's Done.

- **`item set --done` on a card an ask became that no build ran on** (no builder record, branch, PR, pushed branch or held Merge) is refused, naming `reply <card> --close` and `thread <card> --close`. The In Review move and its `awaiting` path in `store.mjs` are gone.
- **`reply --close`** marks the card (`waits_on_owner {on: close}`) and it stays in Todo. Its Hold-row Close is orange (`resolvedBy`), the card reads Action needed, and Next reads "Tap Close". An In Review card keeps "Tap Done".
- **Asks already stored In Review stay there** until the owner's Done; `domain.mjs` keeps only the placement that reads them.
- No button moves and no thread box changes.
