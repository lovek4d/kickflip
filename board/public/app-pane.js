// The board view's pane: from 900px, beside the lanes, the surface every sheet opens into (the reader, a card page, a
// card's questions; ui.js openSheet), each staying until closed. Under them, with none open, the landing: the board's
// name, one line, and chips counting what needs the owner, the questions and the ready cards, each setting the board
// filter to show only those (docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md). Below 900px there is
// no pane, and a sheet opens over the board. A questions URL lands here at every width (shell.js go, focusQuestion).
// Needs app-core.js and app-lanes.js.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc } = BoardUI;

  // The chips in order: the filter box each shows and its words, coloured by AGENTS.md's priority.
  const CHIPS = [['action', 'need you', 'notice'], ['questions', 'questions', 'info'], ['ready', 'ready', 'success']];
  // d: the board; items: its cards as the lanes draw them.
  function renderPane(d, items) {
    const counts = BoardUI.filterCounts(items.filter((it) => !it.isNew));
    const chips = CHIPS.map(([id, words, tone]) => `<button type="button" class="pane-chip ${tone}" data-pane-show="${id}"><b>${counts[id]}</b> ${words}</button>`).join('');
    BoardUI.setHTML($('#boardPane'), `<div class="pane-landing"><h2>${esc(d.title || '')}</h2><p>Open a card to see it here</p><div class="pane-chips">${chips}</div></div>`);
  }
  B.on(B.root, 'click', (ev) => {
    const chip = ev.target.closest?.('[data-pane-show]');
    if (chip) B.showOnly([chip.dataset.paneShow]);
  });

  // The shell's one rule for a questions URL (shell.js go): it shows the board and asks here for the question or topic
  // id, or null for none → false while the board hasn't loaded, so the shell asks again. A card's question or topic
  // opens the card on the board under its questions sheet, which takes the reader's place: it lands on top of it
  // (ui.js openSheet), then the reader closes under it; a card whose questions are all answered just opens. A topic of
  // no card opens its sheet over the board as it is. An id this copy of the board doesn't hold may be newer than it, as
  // a push's can be: the board reloads once, and the shell's retries wait up to WAIT_TRIES for a new copy. An id the new
  // copy doesn't hold either, or none, shows only the Questions filter's cards.
  const WAIT_TRIES = 20;
  let wait = null;
  function focusQuestion(id) {
    if (!state.board) return false;
    const card = BoardUI.cardOfQuestion(state.board, id);
    if (card) B.select(card);
    if (id && B.openQuestionsSheet(id)) { B.closeReader(); return true; }
    if (card) return true;
    if (id) {
      if (wait?.id !== id) { wait = { id, board: state.board, tries: 0 }; B.reload(); }
      if (wait.board === state.board && wait.tries++ < WAIT_TRIES) return false;
    }
    B.showOnly(['questions']);
    return true;
  }

  Object.assign(B, { renderPane, focusQuestion });
});
