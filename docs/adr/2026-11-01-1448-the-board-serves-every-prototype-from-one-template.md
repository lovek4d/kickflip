---
status: superseded in part by 2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card
---

# The board serves every prototype from one template

Superseded in part by [an answered question stops waiting once Claude acts on its card](2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md): a prototype question may list a subset of the takes, in take order.

The owner asked on hub/INT-203 for prototypes that agents can't get wrong: hand-written `prototype-<topic>.html` pages kept drifting from [question add enforces the prototype format](2026-11-01-1318-question-add-enforces-the-prototype-format.md)'s format, with fixed overlays covering the pill and the shell, links that navigated away, hover-only takes, and takes that showed blank or didn't take taps on Waiting on you. Rather than check more of each page, the board now owns the page and an agent writes only the takes.

- `board.mjs prototype add <topic> --title "…" [--card <wave>/<id>] --take KEY:"Label" …` records a prototype in the site's `data/prototypes.json` and prints its take files, `public/prototypes/<topic>/<KEY>.js`. Topics are `a-z0-9-`, keys one capital letter, and labels never start with "A. ": the take pill shows the label alone, as on hand-written pages. `prototype list` and `prototype rm` (refused while an open question uses it) complete the set. A topic whose `public/prototype-<topic>.html` exists is refused, so a recorded topic never hides a hand-written page.
- The board server serves `prototype-<topic>.html` for a recorded topic from `board/public/prototype.html`, filled with the record: the header (back to the card when it has one), the shell's styles and renderers, the shared switcher and the kit. A topic not recorded falls through to the site's files, so old questions keep opening their pages.
- A take file exports `render(stage, kit)`, which draws into a fresh stage on every switch and may return a cleanup. The stage sets `contain: layout paint`, a transform and `isolation`, so it is the containing block of everything in it, `position: fixed` included, and nothing a take draws can cover the header, pill or shell. Links and forms in the stage only toast, and the listeners and timers a take adds to `document` or `window` end on the next switch.
- `question add` accepts a prototype url only for a recorded topic, with `q=<its id>`, option ids equal to the take keys in order, and every take's file written; it refuses a hand-written page for a new question. Each refusal is one line naming the fix. A question that re-asks one on the same topic and prototype resolves the open one, noting "Replaced by <new id>".
- On Waiting on you every take frame takes taps, and a choice above the full-width frame switches the take in place through the frame's `PrototypeSwitcher.current.go(key)`, keeping the frame and its scroll; `?take=` alone still renders one take.
