// The board's one open selection: the card the lanes open, set by every pick, a question link, an opened card or a
// fragment on load, and kept in the fragment (docs/adr/2026-11-14-2359-one-owner-of-the-open-selection.md). Needs
// app-core.js and app.js's focusOnBoard.
BoardView.part((B) => {
  // Selects card key. board: false leaves the lanes where they are, as a card the owner just opened is already shown;
  // otherwise the board opens and scrolls to it, and a card it doesn't show is no selection.
  function select(key, { board = true } = {}) {
    if (board) B.focusOnBoard({ key, changes: { selectedCard: key } });
    else B.saveFragment({ selectedCard: key });
  }

  Object.assign(B, { select });
});
