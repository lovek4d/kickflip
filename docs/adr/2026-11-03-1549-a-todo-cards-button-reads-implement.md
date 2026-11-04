# A Todo card's button reads Implement, and Build and Serve only mean the package

Build meant two things on the board: the Todo card's button that starts an agent on the card, and the button and badge that build or serve a worktree or main with the **build script**. Owner-facing words now keep Build for the package and call work on a card implementing:

- **The Todo card's button reads Implement** (`board/public/ui-cards.js` `buildButton`), "Starting…" while the board server starts it. Its confirms read "Implement #92? Claude starts its implementer now with the notes as they stand.", "Unhold and implement #92?" and, on a blocked card, "Implement #92 once #53 is done? It waits in In Progress until then." (`board/public/app-cards.js`).
- **The card's agent is an implementer.** Thread agent lines read "Claude Opus implementer started" and "finished", a label's builder reading implementer (`board/domain.mjs` `agentName`), and so does its judgment calls header. The Stalled chip and its Nudge confirm, the sidebar's "Update waits for 2 implementers", the new board sheet, Restart, the Usage card ("Codex implements and reviews") and Settings' Auto-pull say implementer.
- **Its status reads implementing.** The open card's Status row shows the `building` status as implementing, and a hub row whose board has an agent on a card reads Implementing (`hub/home.mjs` `siteStatus`).
- **Refusals and the queue say so too.** "Couldn't start implementing: <reason>", "…then tap Implement.", "Implement queued: it starts once #53 is done." (`board/store.mjs`), and a card with no take picked "isn't ready to implement".
- **Build, Building…, Install, Serve, Serving… and Visit stay** for a worktree's and main's package (`ui-cards.js` `tryWords`), as do Auto-build and the Builds settings section.

The code keeps its names: `buildable`, the `card-build` event, the `building` status and phase, builder records, `builder …` commands and their flags. Only words shown to the owner changed.

The owner (ask, 2026-11-03): "I'm realizing there's some ambiguity between the serve button and build button for building a package versus building a to-do. So I'm thinking maybe build Build becomes implement when it's on a to-do. And then build and serve as for existing work trees." Asked whether the status and agent line change too, the owner picked all.

Considered:
- renaming the internal names to match: the status, event and CLI names are read by sessions, skills and records already written, and the owner's words are about what the board says;
- implementers and prototypers as agent kinds with their own colours: that is #111, which this leaves to build.
