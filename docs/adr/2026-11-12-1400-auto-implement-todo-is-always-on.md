# Auto implement Todo is always on

Supersedes the `auto_pull` toggle of [auto implement fills In Progress up to Maximum parallel implementers](2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md).

Card #594 (from #213). A card reaches Ready only through the owner's Implement or a grill the owner answered, so readying is already the decision to build it. A second switch to let the board pull it added nothing, and with it off a Ready card sat in Todo.

- **The pull has no setting.** `auto_pull` is gone from Board settings, `settings set`, `GET`/`POST /api/settings` and the server's gates. The pull runs whenever an implementer slot is free; a usage pause, Pause hub or Pause board still holds it.
- **Old keys are ignored.** An `auto_pull` in an existing board.json is not read, migrated or rejected on read; saving settings through the API refuses it as an unknown key.
- **Arrival grills keep running.** The toggle's other job, a grill on each arrival, no longer fires for asks, which sort to discussing, but `arrivalsOf` still selects a New-phase card not from an ask (card-added with no phase, ticket-source cards). So `launchArrivals` stays, now ungated; the follow-up that sorts those cards to discussing deletes it.
