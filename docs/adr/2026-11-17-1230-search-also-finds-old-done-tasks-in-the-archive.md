# Search also finds old Done tasks in the archive

The board search (docs/adr/2026-11-17-0613-a-search-bar-narrows-the-board-as-you-type.md) first searched only the Done
cards the page held, and left the archive to its own task (T-348). This is that task.

- **The server does the matching.** GET /api/done takes `q=<words>` beside `before=`: the archive's entries holding every
  word, any case, in their title, key, id or ticket (store.mjs archiveMatching, the search's own match), newest first,
  100 a page, with `left` counting the matches past the page.
- **Typing fetches, debounced 250 ms**, the first page of matches while the bar has words. The matches sit in memory
  (state.found), follow the loaded Done cards, and are dropped when the words clear, when Done's own paging returns. The
  old matches stay drawn until the new page comes, the words' filter hiding those that no longer match.
- **Counts**: Done reads "x of y" with x every match shown or fetched and y the true total, as before. "n older tasks"
  counts the matches not yet shown, so Show more pages the matching archive, not the whole archive.
- **Done's preload stays off while searching**: matches page in by Show more's tap alone.
- An archived match opens as an archived card does.
