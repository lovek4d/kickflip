# A builder status line is a phase and a short detail

A builder reports progress as `board.mjs builder progress <key> --phase <phase> "<detail>"` (`board/store.mjs` `progressLine`). `builder start --phase <phase> --progress "<detail>"` takes the same two.

- **The phase** is one of five: **reading** (the code or plan, reproducing, finding the cause), **building** (writing code, fixing review findings), **testing** (red and green, suites), **checking** (screenshots, a live check, its own diff review) and **landing** (commit, rebase, hand back). The CLI refuses a line with no phase or one off the list. There is no waiting phase: a wait on a lock or a Codex limit goes in the detail.
- **The detail** is at most 80 characters, about two lines on a phone card. A longer one is refused with its length and the cap, so the builder rewrites it; nothing is cut ([0012](0012-lists-never-cut-silently.md)). It says in plain words what the builder is doing and why it matters to the owner. Commits, test counts, ADR numbers, file names and screenshots go in the builder's hand-back and the session's thread message. The CLI doesn't check the words.

The thread keeps every line as `{kind: 'status', phase, text}`, its text reading "Testing: <detail>", or "Codex testing: <detail>" for an agent other than main, named by its kind (`statusToThread`). A line that repeats the thread's last status line is still dropped. The card's line puts the phase first, "● Testing · <detail> · 3m ago" (`board/domain.mjs` `builderOf`, `board/public/ui-cards.js` `builderLine`), and reads "Starting" before the first line. The age is still the time since the newest line, so Stalled is unchanged. Status lines with no phase, written before this or by `builder done`'s note, read as written in the thread and on the card.

An audit of 735 status lines (hub/GH-41) found free text, a median of 75 characters, 15 lines cut mid-word at the old 160-character slice, and test counts, hashes, ADR numbers and file names the owner can't use at a glance. The owner picked the phase flag, the 80-character cap, plain words set out in the brief and the phase as the line's first word (owner, 11/03).

Considered:
- a five-step strip under the title showing how far along the build is, which the owner liked but held as follow-up #43, since it adds a row to every building card and builders don't go in order;
- a free-text line with only a cap, which leaves the shape to each builder;
- the CLI refusing hashes, counts or file names in the detail, which polices words the brief can ask for.
