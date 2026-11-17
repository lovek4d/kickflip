# The Tickets setting alone decides badges and refs

An item file used to carry `internal: true`, which gave its cards an `INT-<n>` ref, no repo, a quiet badge and a skip when linking Linear ids. Only this board's file set it, and the owner asked for it to go.

Now a card's badge is its ticket from the board's source, else its Linear ids, else its `T-<n>` (a task). A card's repo is the board's, as for any file. An `S<n>` id still reads `INT-<n>` by its shape, so old Done cards keep their refs. The board server drops the flag from each item file as it starts (store.mjs stripDeadFields).
