---
status: accepted
---

# Lanes list oldest first by arrival, Done newest first

Amends [each lane has one fixed order](2026-11-03-0223-each-lane-has-one-fixed-order.md): In Progress and In Review list oldest first, not newest first, as Todo already does ([new Todo cards join the bottom](2026-11-05-2345-new-todo-cards-join-the-bottom.md)).

The owner asked that every lane list oldest at the top except bumps, and that new work move in at the bottom, by arrival in the lane. `laneOrder` (`board/public/ui-order.js`) now sorts every lane but Done oldest first by `sortAt`, bumped cards on top. The keys are unchanged: `progressSince` and `reviewSince` already are the arrival in the lane, and Todo's `created` is its arrival, so a card sent back to Todo (blocked, or a build that failed to start) keeps its old spot near the top. Done stays newest first, as it pages from the archive newest first.

Considered:
- `lane_at` as every lane's key: a send-back to Todo restamps it and would drop the card to the bottom, which the owner declined.
