# The board filter shows only what its checked boxes match, shares the pills' names and has a banner

Amends [one board filter replaces Waiting on you](2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md).

Card #1067, with the ask folded in from T-723. "Show only Ready" still left the other lanes' cards on the board, because a card matching no box always showed.

- **One list of four names, in this order:** Action needed, Open questions, Ready, Blocked. The funnel's menu and the pane's chips both read it (`FILTER_BOXES`). The pane gains a Blocked chip. This replaces the menu's Ready, Action needed, Questions, Blocked and the chips' "need you", "questions", "ready".
- **The filter applies to every lane.** With any box unchecked, a card shows only when a checked box matches it; a card no box matches (most In Progress, In Review and Done cards, discussing cards) hides too. All boxes checked is no filter. This replaces "an unchecked box hides every card it matches".
- **A filter banner** in the chain banner's style (blue), under it when a chain is on too, each with its own ×. It reads "Showing <checked names> · N hidden", and its × resets the filter.

Considered: one combined banner for a filter and a chain together. The owner chose two stacked banners, each ending its own narrowing.
