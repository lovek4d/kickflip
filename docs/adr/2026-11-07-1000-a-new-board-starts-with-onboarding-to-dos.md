# A new board starts with onboarding to-dos

The owner settled these in the grill on #369. A new board no longer opens on an empty page: its `data/wave.json` is made with onboarding cards already in Todo, and the board's own arrival pull starts their grills, so a first-time user watches grills run side by side and cards move into In Progress.

- **Where.** `bin/kickflip.mjs` `boardFiles` writes the cards when it creates `data/wave.json`, which both New board (the session's `kickflip join --template board`) and bare `kickflip join` go through. A board whose file exists, reopened or already running, never gets them: new boards only.
- **Which.** Two cards, filed `grilling`: prepare `.kickflip/build`, then write the repo's `CONTEXT.md` glossary and first ADR. The build card is left out when main already holds an executable `.kickflip/build` or `.kickflip/build-<target>` (`board/onboarding.mjs` `hasBuildScript`).
- **Tickets.** Each card carries a stored Internal ticket (`INT-n`, or the board's internal prefix), so no issue opens on GitHub or Linear and `tickets backfill` skips them.
- **Instructions.** Each card's notes file, written beside `wave.json` from a template in `board/onboarding.mjs`, is read by its grill and builder like any card's. No new skill: `kickflip init` already names the hub's first-time setup.
- **Several build types.** The build card's notes tell it to write one `.kickflip/build-<target>` for each type the owner wants and to set the board's Build target to the one picked. Until a card does, #366's prototype planner still writes a build script on first use.

Considered:
- seeding at the board server's start: it would reach existing boards, which the owner ruled out;
- a companion skill: the template in board code is read by the same grill and builder as any card.
