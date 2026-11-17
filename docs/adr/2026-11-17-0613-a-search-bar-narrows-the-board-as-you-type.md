# A search bar narrows the board as you type

The owner (task #939) wanted to find a task on a busy board without scrolling every lane, narrowing as they type, with a
keyboard shortcut "to stay on theme". The grill and the prototype (take C) settled each part.

- **A full-width bar at the top of the lanes**, opened by the header's magnifier, by f pressed twice (like ss, hh and
  nn) or by /, from anywhere on the board outside a text box. It pins under the header on a desktop and under the status
  bar on a phone, where the lanes scroll beneath it. A desktop shows a "↵ open · esc close" hint; a phone does not.
- **Every typed word, any case, anywhere in the task's title, key or ticket.** A whole key is text like any other: T-33
  also shows T-330. Matching words are marked in the titles.
- **It narrows everything on the board**: the New strip (an entry's text or its task's key, title or ticket), Auto
  Review (a PR's title or number) and every lane. Non-matching cards hide. Each header keeps its count as "x of y", even
  at 0, and the Todo filter still applies under the search. With no match anywhere the board shows just the 0 counts,
  no line of its own.
- **A folded lane holding a match opens while the search lasts**, and folds back after. The search's opening and
  folding is never stored as the lane's own state.
- **Enter opens the top match on a desktop**: the New strip's first match, else the first card down the lanes, Auto
  Review leading them. On a phone the keyboard's Search key, or a drag on the page, hides the keyboard and keeps the
  filter; a tap on a card opens it as usual.
- **Esc or the × clears the search and closes the bar.** The words live in memory only: a reload ends the search, and
  nothing goes in the URL.
- **A link to a card the search hides** asks "This task is not currently visible, reset filters?", as one the Todo
  filter hides does; yes clears the Todo filter and ends the search.
- **Only the cards the board holds.** Done searches its loaded cards, and its Show more and "n older tasks" stay, so
  the list is never cut silently; paging in the archive stops while the search has words. Searching the Done tasks the
  board hasn't loaded is docs/adr/2026-11-17-1230-search-also-finds-old-done-tasks-in-the-archive.md.

Considered: a field in the header nav, and a field that takes the title's place (takes A and B). The owner picked the
bar under the header. ⌘K was considered for the shortcut; the board's shortcuts are letters pressed twice, so ff, with
/ as the common search key beside it.
