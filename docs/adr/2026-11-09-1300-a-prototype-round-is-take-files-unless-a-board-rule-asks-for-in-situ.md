# A prototype round is take files unless a board rule asks for in situ

Card #463. ADR 2026-11-06-1500 made every web prototype run in situ, in the board's base prototype worktree. The owner asked on 11/09 to drop that default: serving the spare worktree proved fragile, and on a board whose prototypes live in the same repo the existing components are already at hand.

## Decision

- **Take files are the default.** The prototype planner invokes the prototype skill and records the round with `prototype add <topic> --card <key> --take K:label …`, writing the take files built from the repo's existing components fed mock data. A take shows its own states inside itself; `--state` stays served-only.
- **In situ is opt-in by board rule.** The planner brief (`board/headless.mjs` `plannerBrief`, step 4) builds in situ only where one of the board's rules asks for it. The hub-orchestrator board's rule now asks for the standard throwaway pages, so it gets take files like kickflip-sh.
- **The in-situ machinery stays**: `prototype base`, `--served`, `--state`, try key `prototypes` and the served render check work as ADR 2026-11-06-1500 describes.

## Consequences

- ADR 2026-11-06-1500's Consequences line, that the planner "builds rounds in the base worktree", holds only where a board rule asks for in situ; its other decisions describe how an in-situ round works.
- The prototype template loads the board's scripts, so a take reuses board components; hub-page components aren't loaded there, so a hub-UI take reuses them by path or copy.
