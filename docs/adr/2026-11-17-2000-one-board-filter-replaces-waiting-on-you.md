# One board filter replaces Waiting on you

Supersedes [the Todo header has a filter](2026-11-12-0600-the-todo-header-has-a-filter.md), [Board and Open questions are two pages](2026-11-07-1300-board-and-open-questions-are-two-pages.md), [back follows the page tree](2026-10-30-1125-back-follows-the-page-tree.md), [the questions page is one queue of what the badge counts](2026-11-14-2330-the-questions-page-is-one-queue-of-what-the-badge-counts.md), [on a phone the board and Waiting on you switch in place](2026-11-14-2332-on-a-phone-the-board-and-waiting-on-you-switch-in-place.md), [the phone switch slides the view](2026-11-15-0830-the-phone-switch-slides-the-view-not-the-bottom-bar.md), [Waiting on you is one list of rows](2026-11-15-1200-waiting-on-you-is-one-list-of-rows-opening-the-questions-sheet.md), [Waiting on you follows the tap](2026-11-15-1400-waiting-on-you-follows-the-tap-not-the-board.md), and the Waiting on you half of [the desktop pane is back](2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md) and [the desktop pane shows the lanes' board](2026-11-14-2230-the-desktop-pane-shows-the-lanes-board.md).

Card #974. Every open owner question now sits on a card topic, and a card's questions open in the questions sheet from its thread, so the Waiting on you page repeated the board as a list. The owner asked to drop it and its ? badge, and to find what needs them with one filter over the whole board instead.

- **One filter in the header**, between search and the waits mark (which stays rightmost). The funnel opens a checklist: Ready, Action needed, Questions, Discussing, Blocked. All are checked by default.
- **Hide any.** Unchecking a box hides every card it matches, in every lane, and nothing else; a card hides when any of its boxes is unchecked. There is no precedence between boxes.
- **The funnel has no count** and turns orange (attention) while any box is unchecked.
- **Kept per device** in the board's store as `boardFilter`, the unchecked boxes. The Todo-only `todoFilter` is not migrated: a device starts with everything shown.
- **On a phone the menu opens upward** from the bottom bar.
- **`#show=a,b` shows only those boxes.** Needs-you pushes link to `#show=action,questions`. A questions.html URL redirects to the board: with a question id it opens that card and its questions sheet (a topic with no card opens its sheet over the board), and without one, or with an id the board still doesn't know after one reload, it shows only Questions.
- **The desktop pane keeps the last sheet.** With none open it shows a landing: the board name, "Open a card to see it here", and chips that set the filter: need you (orange), questions (blue), ready (green). A chip shows only its box. The pane stays hidden on a phone.
- **No page tree.** With one page left, Back is the browser's; the router keeps only the selected card in the fragment.

Considered: keeping Waiting on you as a filter preset page. It would be the board again under another name, which is what the owner asked to remove.
