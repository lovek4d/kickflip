---
status: superseded by ADR-0041
---

# The next Improvements round follows each sent round

Superseded by [0026](0026-the-next-improvements-round-waits-for-two-real-questions.md).

When the owner sends an Improvements round's answers, the session writes the next round right away, while builders work on the picks. It draws on those picks, the day's asks and thread messages, and what the builds turned up. The bulb reads ready once the round is published, so the owner doesn't need to tap it to ask for one. A tap on the bulb still asks for a round when none is waiting.

Rounds came only from a tap, and the owner tapped for a new one each time, often right after sending the last.

Considered:
- only on a tap, as before;
- once a day, with the morning push.

The owner chose a round after each sent round (round `site-v12`).
