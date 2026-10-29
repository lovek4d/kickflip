# Site cards build in parallel when their files don't overlap

Each site card declares the files it expects to touch, naming board page scripts from the table in [CONTEXT.md](../../CONTEXT.md#board-page-files). The owning session splits its queued cards by those files. Cards with no file in common build at the same time, each with its own builder. A card that shares a file with one already building waits for it, through its `deps` ([0020](0020-cards-wait-on-explicit-blocked-by-links.md)), so its card reads Blocked by.

Two builders editing one file at once would overwrite each other's work, since site work happens in a shared folder rather than separate branches. A single builder for the whole queue kept that safe, but small cards waited behind large ones. The board page's scripts are split by area so that cards on different areas rarely share a file.

Considered:
- one builder taking the whole queue in one pass;
- one card at a time, as before.

When a card finishes, its thread gets a text summary. Screenshots stay on the Mac.

A builder hands a finished card back with `item set <key> --status checking`, not `done`. The card stays in In Progress, since Claude acts next ([0045](0045-the-lane-follows-who-acts-next.md)), reading "Claude checking", and it doesn't unblock dependents. The owning session runs the tests, checks the board at phone width, writes in the card's thread what it checked, and only then sets `done`, which unblocks dependents. Done then means verified work, not a builder's own claim, which the owning session reads as a claim to check (owner, round `site-v21`).

A small tweak skips the queue: a change of up to about 10 lines in one file, which the owning session makes at once, checks at phone width, and records as a done card with a thread line. Anything larger, or anything that changes behavior, goes to a builder (round `site-v19`). Builders working at the same time re-read a shared file such as `style.css` right before each edit.

The owner chose parallel builders for cards that don't share files, and text-only summaries (round `site-v14`).
