# Card logic lives in one pure module, and pages only render its fields

`board/domain.mjs` turns a plain-data snapshot into cards: lane, what it waits on, builder line, review state and age, thread, and question state. It reads no files, and `domain.test.mjs` tests it. Pages render the fields it returns and never derive state again. Shared rendering lives in the `board/public/ui*.js` files.

The owner asked for this to be centralized when the builder line was added (round `site-v5`). Earlier, the server and each page derived lanes and waiting state separately, and they drifted.
