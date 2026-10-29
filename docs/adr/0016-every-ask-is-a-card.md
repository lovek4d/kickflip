---
status: superseded by ADR-0047
---

# Asks wait in a strip, then become Done items with their own thread

Superseded by [0047](0047-the-plus-makes-a-new-card.md) on where an ask waits and how it joins work: a New card in Todo replaces the strip, and an ask that becomes work or joins a card shows in that card's thread instead of as a Done item. Done items, their threads and the answer banner below still hold.

An ask the owner sends from the + button waits in a "Waiting for Claude" strip above the lanes. Once Claude answers it or links work to it, it is a Done item like any other, unless Claude keeps it open for the owner to finish.

- **While it waits,** the ask is one row in the strip: its whole text, wrapping, then "<time> · Bumped · Waiting" or the orange "Working on it". Bump, edit and delete sit as icons at the row's right ([0014](0014-a-pending-ask-can-be-deleted-or-bumped.md)). A row doesn't expand. The strip lists bumped asks first, the latest bump on top, then the rest oldest first, so the top row is the next one taken. It hides when empty.
- **It leaves the strip** when Claude replies to it (`board.mjs reply <eventId>`), writes a line in its thread (`board.mjs thread ask:<eventId>`), or links work to it. An answer that waits on the owner, such as a pick between prototypes, can keep it in In Review with an Action needed badge until the owner presses Done in its thread ([0035](0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)).
- **As a Done item** it renders like any other Done card, with an "Ask" chip where an INT or Linear chip goes, and the ask's first line as its title. It follows Done's rules: open for 7 days, then under the "N older" fold ([0012](0012-lists-never-cut-silently.md)).
- **Its thread** (key `ask:<eventId>`) opens with the original ask and its attachments, Claude's reply under it, then any later lines. It has a reply box like a work item's thread: the owner's replies send `item-message {key: "ask:<eventId>", text}` and take Working on it, edit and delete as any thread message does.
- **Linking to work.** `board.mjs item set <wave>/<id> --from-ask <eventId>` names the ask a new work item came from; `board.mjs item relate-ask <eventId> <wave>/<id> --summary <text>` links it to an existing item, whose thread gets the summary line linking back. Either way the ask's thread shows a link line, "Became INT-21 →" or "Added to B5 →", that opens the card. The board derives the line from the item's `from_ask` or `data/ask-links.json`, so asks linked before this change show it too. The work item's thread still opens with the original ask. Claude names a new item for the change, not with the ask's wording.

- **An ask linked to an existing card** (`relate-ask`) is part of that card's work: the session moves the card to Done only once its linked asks are handled. An ask that would hold a card up becomes its own card instead (owner, round `site-v16`).
- **An ask that only needs an answer** is its own small item: it goes straight to Done once answered in its thread, as above (owner, round `site-v16`).
- **Hearing the answer.** When Claude answers an ask that became no work, the owning session pushes the answer, opening the ask's card (`#item=ask:<eventId>`). The board also shows one banner at the top of the page, above Needs you, while any such ask has a Claude line this browser hasn't seen, by the same seen marks as the unread line: "1 answer · <ask>" or "2 answers · <newest> and 1 more", on one line. A tap opens the newest one's card in Done and marks it seen. ✕ hides those answers on this device until a newer Claude line comes. An ask first seen in the strip counts its answer as new; one this browser first sees in Done does not. The push and the banner cover each other: a swiped-away push still leaves the banner (owner, round `site-v17`, take A; considered: push only, banner only).

The ask is never replaced or hidden, so it stays the one place that shows what the owner asked and where it went, while the lanes hold only work.

Considered:
- an Ask card in In Progress, replaced by its work item, with answered asks folded under "N answered asks" in Done and dropped after 48 hours (rounds `site-v11` to `site-v14`);
- an answered ask as a subtask under the work it joined;
- an ask row that reads like a work card, or a chat-bubble queue (prototype takes B and C).

The owner chose the strip (take A) with its icons kept, and asks in Done as normal Done items with an Ask chip, linked to their work in the ask's thread and open to replies, on 2026-10-23, after rounds `site-v14` and `site-v15`.
