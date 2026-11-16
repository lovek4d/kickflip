# Onboarding cards cover only what the repo lacks

The owner asked on #877 that onboarding avoid running, or run narrower, when `.kickflip/build` or `.kickflip/release` already exist. Amends [a new board starts with onboarding to-dos](2026-11-07-1000-a-new-board-starts-with-onboarding-to-dos.md).

- **What main holds.** `board/onboarding.mjs` `repoHas` reads main's tree for an executable `.kickflip/build` (or `build-<target>`), an executable `.kickflip/release`, a `CONTEXT.md` and a `docs/adr` directory.
- **Build card.** Neither build nor release: "Prepare .kickflip/build and .kickflip/release". One of them: a card for the missing one, its notes holding only that part. Both: no card.
- **CONTEXT card.** Neither CONTEXT.md nor an ADR: the whole card. One: a card for the missing one. Both: no card.
- **Ids.** Cards are numbered T-1.. after the left-out ones are dropped.

Considered: keeping the cards and letting the grill discover what exists; the card would still occupy a slot and an agent run to learn nothing.
