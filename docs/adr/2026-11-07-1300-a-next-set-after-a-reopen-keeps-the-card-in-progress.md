---
status: superseded in part by 2026-11-09-1804-in-progress-means-a-builder-runs
---

# A Next set after a reopen keeps the card in In Progress

A reopened card goes to In Progress. Once a Claude line answered the owner's message it had no builder, so it went to In Review with "Tap Done once it is settled", even when the reply was about follow-up work the orchestrator had queued (#377 bounced five times).

A Next now carries `next_at`, stamped when it is set. A reopened card whose Next was set after its move out of Done (`reopened_at`, or the close for a card that merged) has follow-up work: it keeps that Next and stays in In Progress, whatever the owner writes later. Any other Next on a reopened card is still dropped. A build's start clears the Next, so the hold ends with the build. A reopened card whose reply settles it, with no such Next, still goes to In Review for the owner's Done.

The idle pull and Auto-build stay to Todo cards; the orchestrator starts a reopened card's build.

Superseded in part by [In Progress means a builder runs](2026-11-09-1804-in-progress-means-a-builder-runs.md): the follow-up Next holds the card in In Review, off the owner's Done, until a builder starts on it.
