# Every wave header, No wave included, collapses in every lane through one shared header

Only Todo's wave bands folded; Todo's "No wave" and every other lane's groups drew a separate plain header (`wb-loose`, `wb-loosehead`) that did nothing on a tap. Now `groupHtml` (board/public/app-lanes.js) draws one header for every group in every lane, a wave or No wave, and one `data-band-toggle` handler folds it. Todo's richer band head (Notes, Implement, progress words) is content passed into that header, not a second kind.

The open state is stored per lane and slug (`foldOpen:band:<lane>/<slug>`), No wave under the fixed slug `no-wave`. A group starts open, except Todo's wave bands, where only the first with a ready next card starts open as before. A Todo band's stored state under the old `band:<slug>` key is not carried over; those bands fall back to their default once.

A `#selectedCard=` link opens the group in the card's own lane.
