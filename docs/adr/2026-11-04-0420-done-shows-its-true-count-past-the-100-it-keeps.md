# Done shows its true count past the 100 it keeps

Supersedes the "100+" count in 2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md.

- **`/api/board` carries `doneArchived`, the number of archived Done cards.** It is kept in `data/done-archive-count.json`, written with every archive write, so building the board never reads the archive file. An archive from before the count existed is counted once, on first ask.
- **The Done lane counts the board's Done cards plus `doneArchived`**, and Show more reads "N older cards" with that true number, before any page is fetched. Every lane's count is the true count.
- **`GET /api/done` still answers `left`**, which the page no longer uses; the page works out what is older from `doneArchived` less the cards it has paged in.
