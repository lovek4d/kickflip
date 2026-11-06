# Server tests that compare two reads store each card's lane

The gzip test (G cards) and the ETag test (E1/E2) wrote cards with no `lane`. The server's settle pass places each laneless card in `todo` and bumps the change number, so a settle landing between two reads made them differ (`storedLane` null vs `'todo'`, `changed`), or turned an expected 304 into a 200. The product is right; the fixtures raced.

Decision: those fixtures write `lane: 'todo'`, so the settle pass has nothing to move.
