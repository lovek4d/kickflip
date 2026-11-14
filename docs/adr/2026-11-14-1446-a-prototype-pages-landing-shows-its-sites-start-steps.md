# A prototype page's landing shows its site's start steps

This extends [a prototype round is a page in the board's base worktree](2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md), whose served viewer showed one "Starting the prototype site…" line until the base serve was up. The page now shows the real start steps and the log's last line, never an estimated bar (owner, T-98 t98-progress).

## The steps

`hub/try.mjs` `launch` records the base serve's step in try.json's `prototypes` entry. It records it only for the base serve, since only the landing reads it:

- **building**: from the spawn until the build script prints `port N`.
- **starting** ("starting server"): until that port answers the probe.
- **opening**: `openPort`, the tailnet port and its relay.
- **ready**: the serve is up, and the page frames it.

`stepAt` is when the current step began. `steps` holds each finished step's `{name, ms}`, so the landing keeps a finished step's time. A failure keeps the step it failed at and records `error`: the probe's or script's message, else how the script stopped. A launch that fails before it spawns records only `{state: 'failed', error}`, and the landing reads that as a failure while building.

`GET api/try/prototypes` passes `step`, `stepAt` and `steps` while the serve runs or once it failed, and `error` once it failed. While it runs it also passes `last`: the log's last non-empty line, ANSI codes stripped, and for a progress line only the part after its last carriage return, as a terminal last showed it. The page already polls every 1.5 s while the site isn't ready, so there is no new route or push.

## The landing

`prototype-kit.js` `servedStatus` draws the three steps on `BoardUI.progressBar`, the bars the New board row draws, centred in the frame's place, with a caption under each (take A of round `start-landing`). The owner's note on the take: "I don’t want the labels turning green after completion, make them gray instead when not active. Also keep the time for each label after completion". So:

- Only the running step's caption is coloured: orange, as work, with its seconds since `stepAt`. A host clock ahead of the device counts from 0s, as `startCaption` does. Its bar pulses.
- A finished step's caption is grey and keeps its time, such as "building · 4s". A later step's caption is grey with no time.
- Before the hub has a run (the page's ask in flight), step 1 shows at 0s.
- The log's last line sits under the bars, on one line, truncated.
- A failure turns that step's bar and caption red, as a fault. Below it come "The prototype site didn’t start while <step>.", the error, the log's last 40 lines and Try again.
- A site that was up and then exited failing keeps step `ready`. Its landing draws every step done, grey with its time, and says "The prototype site stopped after it started." above the error, the lines and Try again.
- T-120's "The prototype site had stopped. Starting it again..." line sits above the bars while the site starts again. A failure replaces it.

`progressBar` gained `failed`, the index of a step drawn red (`.phase-bars i.failed` in style.css).

## Not the New board row's caption

The landing has its own caption code. `ui-sidebar.js` `startCaption` and `startSteps` are tied to the New board row's three steps (cloning, starting orchestrator, landing it), and write one caption line for the current step, so the grey-after-done rule doesn't reach them. The New board row is unchanged.
