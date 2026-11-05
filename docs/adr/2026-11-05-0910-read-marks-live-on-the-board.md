# Read marks live on the board

A card's read mark, how far the owner has read it, lives on the board server in `data/read.json` `{cards: {key: time}}`,
one set for every device (owner, gh133-where). It used to live in each browser's local storage (`seenThreads`), so a
card read on the Mac stayed unread on the phone, clearing site data lost every unread, and the banner's ✕ held only on
the device that tapped it.

- `store.mjs markRead(site, keys, marks)` writes it: each mark only moves forward, a card on the board with no mark yet
  is read up to the server's now, and a key not on the board is dropped (owner, gh133-prune: a card's mark goes with
  the card, dropped or past the newest 100 Done). Writes run one at a time and only when a mark changed.
- The server runs `markRead` over the board's keys as it starts and after each board change (`markNewCards`), so a card
  new to the board badges only what comes after it, as the browser's "never seen starts from now" did, with the
  server's clock.
- `POST /api/read {marks: {key: time}}` moves marks forward and wakes no session. Every board answer carries each
  card's mark as its `readAt`, so a mark made on one device reaches the others with the next board patch.
- Opening a card marks it read up to the newest message it showed: its `othersAt`, its questions' `askedAt` and its
  `ask.answerAt` (owner, gh133-clock), never the browser's clock. An open card marks again as newer messages arrive.
- The page keeps the later of the board's mark and its own (`app-core.js seen`), so a card read here reads at once,
  and redraws the answer banner as the card opens (owner, gh133-banner). An open card's thread starts its unread lines
  from its mark before it opened (`seenBefore`).
- The banner's ✕ marks each answer it shows read, the same mark as opening it (owner, gh133-dismiss); the browser's
  `dismissedAnswers` is gone.
- Browsers' old `seenThreads` and `dismissedAnswers` keys are deleted unread on load: everything counts as read from the
  switch (owner, gh133-migrate).
