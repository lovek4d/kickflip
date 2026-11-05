# A card's status word comes from a signal the board checks

Card #241 audited every status word a card shows against real headless runs (the card's notes,
`status-audit-notes.md`). Several words claimed work that wasn't happening, or hid work that was: a builder read
"preheating" for up to 78 s while it read code, a grill request with nothing running read blue "preheating" for 73
minutes, a dead builder read its last line for up to 30 minutes, and the open card's Status row printed the wave file's
raw status ("implementing" on a card that had landed).

## Decision

- **starting** is the In Progress builder's word before its first status line (bars: "Starting, no step yet").
- **preheating** is Todo only: a grill or prototype request no planner has picked up yet, in grey with no dot. Once
  the planner runs, the line is blue **grilling** or **prototyping**, and every grill line leads with Grilling
  (`PLANNER_WORD.grill = 'grilling'`).
- **Liveness comes from the process.** The board server's snapshot reads each card's headless process from
  `data/headless-builders.json`, else `data/landers.json`, as `alive {key: bool}`. A build whose process lives is blue
  while it moves, and turns grey (no word) once 5 minutes pass with no status line, no transcript movement and no command running
  (2026-11-05-1403); it is
  never stalled. One whose process is gone without done reads **stopped**, the needs-you red with the nudge, and
  raises `builder-stalled`, once the board has stopped relaunching it: a build handed back after its second exit stays
  tracked, marked `handedBack`, so its card reads stopped from then on. A first exit, or a lander's, relaunches within
  a minute, and until then the card reads as a builder the board tracks no process for: a session's own builder, or a
  planner, keeps the 10-minute Stalled.
- **A lander starts on landing**: its brief's `builder start` carries `--phase landing`, so the card reads landing
  from the lander's first second. `builder done` already posts its own landing line.
- The open card's **Status row** reads what runs on the card, else its lane: grilling, prototyping, implementing,
  landing, stopped, Orchestrator review, preheating, queued, ready, to do, stopped at <phase>, in progress, in review,
  done.
- **A Next never asks for the state the card is in**: `item set` (and `builder done`, which sets through it) refuses a
  ready card whose Next is "Mark ready".
- The unreachable "Queued, no step yet" label is gone: a queued card is in Todo, where there are no phase bars.

## Not done

- The board doesn't read main for landed commits (owner: rely on #240's fix alone).
- A lander keeps the main builder record: `builder done` finishes a card only from main, and the lander already
  shows its own line, since its start moves the card to building.
- A thread reply from Claude doesn't end a request's preheating: the server still has to launch that planner.
