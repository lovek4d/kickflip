---
status: superseded by 2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping
---

# A wave the owner asks for is a lineup of cards

Superseded in part by [a wave builds in phases, and cards in one phase build side by side](2026-11-04-0238-a-wave-builds-in-phases.md): a lineup is a list of phases, and each card is blocked by every card of the phase before, not by the one before it. `lineup create` and `lineup set` take `--phase` per phase.

The owner settled the wave planner on hub/INT-236. A wave starts only when the owner asks for one with the +, or when Claude spots a grouping in Todo and proposes it as a board question. Planning sets their blocked-by links in build order and writes a short note: goal, order and why. Each card stays one PR and starts on its own as it unblocks, with no approval step. A Waves section above In Review, drawn as a lane, holds one row per wave: its name, "N of M merged", its Goal and Order lines, and "Notes ↗ · Triage". Tapping a row shows only that wave's cards, and replaces the wave bars over the lanes.

kickflip already uses "wave" for a wave file: a board over `~/.claude/waves` shows each file as a wave, and every card's key is `<wave>/<id>`. That model can't hold the owner's wave. On a board over its own file, as most boards are, all cards share one file. Moving cards into a new file would change their keys, and threads, question topics, ask links, review links and pushed `#item=` links are all filed under those keys. So the owner's wave is a **lineup**, a named list of card ids kept in the cards' wave file under `lineups`. The UI still says "wave", and code and `board.mjs` say `lineup`, as an ask is the code's name for a new task. A board over `~/.claude/waves` keeps its wave files as rows of the same section, with their name and progress, so their filter survives the bars.

`board.mjs lineup create|add|remove|set|finish` makes every change. Each one rewrites the chain: each card is blocked by the one before it, and its links to cards outside the lineup stay. The note is `lineup-<slug>.md` beside the wave file. `/api/notes?wave=<slug>` adds the current goal and order above it, so a changed order never leaves the note stale. A lineup leaves the section when it is finished or all its cards are Done.

Triage is optional and runs only on request. Triage sends `wave-triage {lineup}`. The row reads Triaging… with an orange spinner until the session replies to that event, as Grill's "Writing questions…" waits on its `grill-more` reply. The proposal comes back as open board questions, one per change, on topic `lineup:<slug>`. Needs you lists them as "<wave> · N questions", and the row reads "Triage: N open questions" in grey until they are resolved. Colours follow [colour says who's waiting](2026-11-01-1817-colour-says-whos-waiting.md): grey for the chip and the idle triage line, and orange while triage runs.

Considered:
- One wave file per wave on every board: it would change card keys whenever a card joins or leaves a wave.
- A `wave` field on each card: in code and the CLI it reads like the card's wave file, which is the confusion this decision avoids.
- A command to mark triage finished: replying to the event already ends the wait, as it does for Grill.
- An Accept box for the triage proposal in the row: the owner chose open questions, one per change, answered like any other.
