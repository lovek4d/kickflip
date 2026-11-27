# A script waiting on a Done card shows Action needed, and item set takes --owner-step

A script offered after a task's merge sat on a Done card with no Action needed, badge or push, because `actionOf` returned null for any Done card before it looked at the script. It now checks the waiting script first; the card stays in Done (2026-11-19-0700 ADR), and only the owner's Reopen moves a Done card (2026-11-18-2359 ADR).

`item set <key> --owner-step <text> [--check]` puts an owner step on a card before its merge, so auto-merge and the owner's Merge keep it in In Review with its ticket open, as a card given the step by builder done or land already does. A Done card still refuses a step.
