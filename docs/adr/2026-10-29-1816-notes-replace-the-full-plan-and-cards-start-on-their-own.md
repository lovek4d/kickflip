---
status: superseded in part by 2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build
---

# Notes replace the full plan, and a card starts on its own

Superseded in part by [a Todo card that nothing blocks has Build](2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build.md): a Todo card that nothing blocks and that has no Action needed has the owner's Build, which starts its builder now. Cards still start on their own.

A card's long write-up is its **Notes**: the owning session's understanding of the task so far, what was asked, what is settled and what is still open. The session rewrites it as the grill settles things, rather than freezing it as a plan, and the thread keeps the short news. A card starts as soon as its open questions are all answered and nothing blocks it; the owner gives no separate go.

- **Notes.** The item names a Markdown file in its wave's folder, set with `board.mjs item set <key> --notes-file <file>`; `--plan` stays an alias, and the file is still stored in the item's `plan`, so wave files and calls written before need no migration. The open card's details list ends with a **Notes** row whose label, "Notes ↗", opens `notes.html?item=<key>`, headed "<ref> notes", from `GET /api/notes` ([notes is a link in the details list, with no stored summary](2026-10-30-1626-notes-is-a-link-in-the-details-list.md)). With no file, the page shows the item's short `notes` text, so notes written before keep showing. The server reads the file under the same checks as before ([a full plan opens as a page on the site](2026-10-29-1639-a-full-plan-opens-as-a-page-on-the-site.md)). `plan.html?item=` redirects to `notes.html` and `/api/plan` answers as `/api/notes`, since pushes and threads already link them.
- **The card's notes section goes.** The open card no longer shows the `notes` text in a fold of its own; the Notes page holds it.
- **Cards start on their own.** Once a card's open questions are answered and none of its deps is unfinished ([cards wait on explicit blocked-by links](2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md)), the owning session starts its builder without waiting for a go. `unblocked: <key>`, printed when a dep reaches done or merged, means start that card now. A held card still waits for Resume ([a card can be held, and every card button confirms](2026-10-29-1639-a-card-can-be-held-and-every-card-button-confirms.md)).
- **No go button.** A card has no owner action for starting, and the board sends no event for it. An `await_build` left in a wave file is ignored.

A card whose plan waited on the owner showed its full plan and an Action needed chip that only opened its thread, and the owner gave the go in a thread message. The owner didn't need the plan as a fixed document, but did want the session's current understanding. A go step after the grill only added a wait: once the questions are answered, the shared understanding is reached.

The owner asked, on a card waiting on them: "should not have full plan visible to user of the board anyway", then "full plan can stay actually, but rename it to notes, drop notes section from the main card, and use that to store a so far understanding of the task" (hub/INT-121). Then: "i think we should just drop the build button etc entirely, we should just always build once shared understanding is reached and blockers are closed" (hub/INT-124).

Considered:
- an orange Build button in the Action needed chip's place on a card the session marked `--await-build`, sending `card-build` and reading "Starting…" until the session acted. It was built (hub/INT-121) and dropped, since every tap only confirmed what the answered questions had already settled. A follow-up's Build ([follow-ups are Todo cards of their wave](2026-10-29-1639-follow-ups-are-todo-cards-of-their-wave.md)) is a different feature and stays;
- renaming the stored `plan` field to match, which would mean migrating every wave file on read for no change the owner sees.
