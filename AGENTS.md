# Agents

Repo-wide conventions for agents working in this repo. CONTEXT.md holds the vocabulary; docs/adr holds the decisions.

## Colour priority

When several statuses compete for one mark (a dot, a badge, a line's colour, a row's word), the order is **red > orange > blue > green > purple > grey**.

- red: faults and what needs the owner now (broken, down, not listening, N need you).
- orange: attention and work (busy, working, starting, a builder's line).
- blue: info for the owner to read or see (updates, review, planners).
- green: done and well.
- purple: merged, past done.
- grey: idle, blocked by the owner, and paused.

A lower colour never hides a higher one: a pause or a busy host drops off a row while a red fault is on it. The meaning of each colour is CONTEXT.md's **Colour rule**.
