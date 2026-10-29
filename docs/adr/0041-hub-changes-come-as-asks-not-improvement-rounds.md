# Hub changes come as asks, not Improvements rounds

There is no Improvements bulb and no Improvements round. A change to the hub or the board template comes in as an ask on the `/hub-orchestrator` board, and a choice it needs from the owner is an open question on that ask's card ([0029](0029-a-card-is-grilled-through-its-own-open-questions.md)). This supersedes [0018](0018-the-next-improvements-round-follows-each-sent-round.md), [0026](0026-the-next-improvements-round-waits-for-two-real-questions.md) and [0027](0027-one-improvements-round-covers-the-hub-and-every-site.md).

The rounds gave questions about the hub and every site a home on one board, behind a bulb on every page. The hub now has its own orchestrator board, where asks and per-card questions cover the same ground with the machinery every board already has. A second channel for the same changes only split where the owner's decisions lived.

What went with it: the bulb in every page header, `/_hub/improvements.json` and `hub/improvements.mjs`, the Improvements section on hub Settings and Improvements decisions on board Settings, the `improvements_site` setting, `grill.html`, `board.mjs grill add`, `item set --from-grill` and an item's `from_grill`, the `grill-answers` and `brainstorm-improvements` events, and the grill form of `prototype-request` (`{grill, question}`). A prototype request from a card's thread (`{key}`) stays ([0015](0015-prototypes-come-on-request.md)).

The owner chose this on 2026-10-29 (card `hub/INT-101`).
