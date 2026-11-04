---
status: superseded in part by 2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once and 2026-11-02-1727-a-card-can-be-held-until-a-time
---

# A card can be held, and every card button confirms

Superseded in part by [the board applies the owner's Hold, Resume and Done at once](2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md): the card shows the owner's Hold or Resume at once, with no "Holding…" or "Resuming…".
Superseded in part by [a card can be held until a time](2026-11-02-1727-a-card-can-be-held-until-a-time.md): Hold opens a duration picker in place of its confirmation.

An open work card that isn't Done has a **Hold** button first in its action row, then Grill; its bump is an icon at the card's top right ([a card that hasn't started, or is running, can be bumped](2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md)) and confirms the same way. On a held card it reads **Resume**.

- **Hold** sends a `card-hold` event `{key, hold: true}`, and Resume sends `{key, hold: false}`. The owning session runs `board.mjs item set <key> --held` or `--unheld`, which sets or clears the item's `held` in its wave file and records `held_at`.
- **A held card never starts on its own.** `item set --status building` refuses while it is held, `--status done` and `merged` leave it out of their `unblocked:` lines ([cards wait on explicit blocked-by links](2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md)), and a held card can't be bumped. A running card that is held gets no new work until it is resumed: no new builder, review fixes or CI reruns.
- **The button shows "Holding…" or "Resuming…"**, disabled, while the latest `card-hold` for the card asks for the other state and is newer than its `held_at`. A later `--held` or `--unheld` from any cause ends it, so a hold the session settled another way never stays pending.

Every button in the open card's action row asks first, in the browser's native dialog, with a line naming the card by its ref ("Hold INT-41? It won't start until you resume it."). Cancel sends nothing. Grill sends no focus text; the owner adds any in the thread. Links in the row, such as Action needed and Review on GitHub, only navigate; Rebuilding… asks before opening an older install ([a device app card carries an Install link](2026-10-29-1729-a-device-app-card-carries-an-install-link.md)).

Every confirmation on every board page goes through `BoardDialogs.confirm(message)`, a promise of true or false, and every one-button notice through `BoardDialogs.notice(message)`, both in `board/public/dialogs.js`, which each page loads (the board view's parts reach them as `B.confirm` and `notice`). Unlabelled confirmations and notices wrap `window.confirm` and `window.alert`. `confirm(message, {ok, cancel})` uses a modal bottom sheet with those action labels, as the install rebuild confirmation requires ([a device app card carries an Install link](2026-10-29-1729-a-device-app-card-carries-an-install-link.md)); Cancel, Escape and tapping outside cancel it. The board view passes an abort signal with its confirmations, so unmounting the view cancels and removes its sheet. The card buttons, follow-up Build and Plan, a thread's prototype eye and its bump, and deleting a waiting message all use them (owner, card INT-60).

A stray tap on a phone sent an event that woke the session and changed the queue, and the owner had no way to pause a card short of writing an ask.

Considered:
- an inline confirmation that swapped the action row for a line with the action, Cancel and Grill's focus field. It was built first, then replaced so every board button confirms the same way as the Improvements bulb did, before the bulb went ([hub changes come as asks, not Improvements rounds](2026-10-29-1639-hub-changes-come-as-asks-not-improvement-rounds.md));
- a held status in place of a separate `held` flag, which would lose the status the card had.

The owner asked for Hold, Prioritize and Grill buttons, each with a confirmation (owner ask, 2026-10-23; INT-41), then for native confirmations like the Improvements bulb's, all through one helper that can be replaced later (owner ask, 2026-10-23; INT-60).
