// The board's one open selection: the card the lanes open and the topic the pane shows, set together by every pick, a
// question link, a pill, an opened card or a fragment on load (ui-selection.js nextSelection)
// (docs/adr/2026-11-14-2359-one-owner-of-the-open-selection.md). The fragment holds both, written in one write, so a
// replay of it lands where the owner last picked. Needs app-core.js, app-pane.js and app.js's focusOnBoard.
BoardView.part((B) => {
  const { $, state } = B;
  let generation = 0;

  // The phone's ? opens the selected card's topic, when it has open questions.
  function syncQuestionsLink() {
    const link = $('#questionsLink');
    if (link) link.setAttribute('href', BoardUI.questionsHref(state.board, AppRouter.fragmentOf(location.hash).selectedCard));
  }

  // → true once the pick is set. A question or topic waits (false) while the pane hasn't loaded, so the caller asks again;
  // a card pick shows its topic in the pane when there is one to show, and is set either way.
  // board: false leaves the lanes where they are, as a card the owner just opened is already shown; pane: false leaves
  // the pane, as a pill the owner just tapped is already open.
  function select(event, { board = true, pane = true } = {}) {
    const r = BoardUI.nextSelection({ board: state.board, event, generation });
    const shown = !pane || r.topic === undefined || B.openPaneTopic(r.topic);
    if (!shown && !('card' in event)) return false;
    generation = r.generation;
    if (board && r.card && B.focusOnBoard({ key: r.card, changes: r.changes })) { syncQuestionsLink(); return true; }
    // A card the board doesn't show is no selection: only the pane's topic is written.
    const { selectedCard, ...paneOnly } = r.changes;
    B.saveFragment(board && r.card ? paneOnly : r.changes);
    syncQuestionsLink();
    return true;
  }

  // The pane's pill the fragment names opens once the pane has loaded; a pick since then drops the retry.
  function replayTopic(id, tries = 50) {
    if (!id || !matchMedia('(min-width: 900px)').matches || select({ topic: id }, { board: false }) || tries <= 0) return;
    const at = generation;
    B.later(100, () => { if (generation === at) replayTopic(id, tries - 1); });
  }

  Object.assign(B, { select, replayTopic, syncQuestionsLink });
});
