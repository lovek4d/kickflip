---
status: superseded in part by 2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once, 2026-11-09-2000-old-asks-migrate-into-cards-and-the-ask-only-records-retire
---

# An ask can wait on the owner before Done, and the owner closes any open card from its thread

Superseded in part by [the board applies the owner's Hold, Resume and Done at once](2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md): a work card's or follow-up's Done moves the card at once, with no "Closing…"; the session records it afterwards.

Superseded in part by [old asks migrate into cards, and the ask-only records retire](2026-11-09-2000-old-asks-migrate-into-cards-and-the-ask-only-records-retire.md): there is no ask row, `ask progress`, `ask done` or `ask-done` event. An answered ask is a card waiting in In Review for the owner's Done. The thread's Done on any open card holds.

An answered ask whose answer waits on the owner, such as a choice only the owner can settle, stays open instead of going to Done's Asks fold. It sits in In Review with an Action needed badge linking to its thread, and moves to In Progress while an owner message in its thread waits on Claude ([the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md)). Every open card's thread has a **Done** button, just left of Send in its reply form, that the owner uses to close the card at any time. A card already in Done has none.

- **Done confirms first**, like every card button ([a card can be held, and every card button confirms](2026-10-29-1639-a-card-can-be-held-and-every-card-button-confirms.md)). For an ask it reads "Mark this ask done?"; for a work card or follow-up it reads "Close <ref>?", and adds that an open PR stays open on GitHub.
- **Claude marks an ask as waiting on the owner** with `board.mjs ask progress <eventId> [--next <text>]`, which writes `{state: "progress", at, next}` for the ask in the site's `data/ask-progress.json`. The ask leaves the Waiting for Claude strip, keeps its Ask chip and thread, and shows `--next` as its "Next:" line.
- **An ask's Done sends `ask-done {id}`**, with the ask's event id, and the event alone moves the ask. `board/domain.mjs` keeps the ask open while Claude's progress mark is newer than the owner's latest `ask-done`. `board.mjs ask done <eventId>` writes a done mark, which moves it the same way, and a later `ask progress` puts it back. The session needs no action beyond relaunching its watcher. Once done, the ask folds under Done's Asks row ([lists never cut silently](2026-10-29-1639-lists-never-cut-silently.md)).
- **A work card's or follow-up's Done sends `card-done {key}`.** The wave file stays the source of truth, so monitor and the GitHub checks stop treating the card as live only once the owning session applies it: `board.mjs item set <key> --status done` for a work item, or `followup done <wave> <id>` for a follow-up, plus a thread line. Closing never touches GitHub, and an open PR stays as it is.
- **The button reads "Closing…", disabled,** while the latest `card-done` for the card is newer than its `status_at`, which `item set` records on every status change. A follow-up has no `status_at`, so it reads "Closing…" until it is done. Any later status change ends it, so a close the session settled another way never stays pending, as with Hold's "Holding…".

An answered ask went straight to Done, so an answer that waited on the owner's pick, as a prototype answer does ([prototypes come only when obviously helpful or on request](2026-10-29-1639-prototypes-come-on-request.md)), dropped out of sight while it still needed the owner. A work card had no way to close short of writing an ask.

Considered:
- turning a waiting ask into a work item (`item set --from-ask`), which adds a card and a wave entry for an answer that builds nothing;
- Done in the card's action row, where work cards have Hold, which was built first and then moved beside Send;
- a work card's Done moving the card itself from the event, as an ask's does, which would leave the wave file saying the card is live, so monitor would keep building and checking it.

The owner asked for prototype asks to go to In Progress with a Done button in place of Hold, then for Done to sit left of Send, then for it to be there always, closing a work item at any time (owner asks, 2026-10-23).
