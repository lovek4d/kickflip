// The board view's pane: from 900px, Waiting on you (view-questions.js, embedded) beside the lanes, mounted while the
// width lasts (docs/adr/2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md). Every questions URL lands
// here at that width (shell.js go, focusQuestion), and a click on a topic's row focuses its card on the board under the
// questions sheet (docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md). Below 900px there is no pane: the
// header's ? opens Waiting on you as its own page. Needs app-core.js.
BoardView.part((B) => {
  const { $, state } = B;

  // From 900px, the pane beside the lanes, the same width the stylesheet splits the board at.
  const wide = matchMedia('(min-width: 900px)');

  // A fresh board repaints the pane's questions.
  function renderPane(d) {
    questions?.B.take(d);
  }

  let questions = null;
  // A click on a pane row focuses its place on the board: item:<key> is a card (an ask is one, ask:<id>), review:<PR
  // number> a held review in the Auto Review lane; any other topic, or one the board doesn't show, does nothing.
  function openOnBoard(id) {
    if (id.startsWith('item:')) B.select({ card: id.slice(5) }, { pane: false });
    if (id.startsWith('review:')) B.openReview(Number(id.slice(7)));
  }
  // What can cover the pane: each closes itself.
  const paneOverlays = [() => B.closeReader?.(), () => B.closeQuestionsSheet?.()];
  // The pane marks its topic: a questions URL (focusQuestion) lands here.
  function showTopic(id) {
    for (const close of paneOverlays) close();
    B.saveFragment({ openItemsCard: id });
  }
  function fitPane() {
    if (wide.matches === Boolean(questions)) return;
    if (questions) { questions.unmount(); questions.slot.remove(); questions = null; return; }
    $('#boardPane').insertAdjacentHTML('beforeend', `<div class="view-questions pane-questions">${AppViews.questions.markup({ embedded: true })}</div>`);
    const slot = $('#boardPane .pane-questions');
    // The lanes' board is the pane's: the pane holds none of its own, and renderPane hands it each board that lands.
    const host = { board: () => state.board, send: (kind, data, signal) => B.send(kind, data, null, { signal }), reload: () => B.loadBoard({ via: 'signal' }) };
    // A row's questions sheet takes the place of the reader.
    const openSheet = (id) => { B.closeReader?.(); return B.openQuestionsSheet(id); };
    questions = Object.assign(AppViews.questions.create(slot, B.site.root, { embedded: true, host, openOnBoard, onTopic: showTopic, openSheet, openPage: (href) => B.openPage(href) }), { slot });
    questions.mount();
  }
  // The shell's one rule for a questions URL from 900px (shell.js go): it shows the board and asks here for the question
  // or topic id, or null for none. The selection sets the topic in the pane and its card on the board (app-selection.js)
  // → false while there is no pane or it hasn't loaded, so the shell asks again.
  // An open question's id also opens its questions sheet
  // (docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md).
  // Below 900px the shell asks only for a card's question or topic: with no pane, the card opens on the board under the
  // topic's questions sheet (docs/adr/2026-11-16-0828-on-a-phone-a-cards-questions-open-over-the-card.md)
  // → false while the board hasn't loaded.
  function focusQuestion(id) {
    if (!wide.matches) {
      if (!state.board) return false;
      B.select({ question: id }, { pane: false });
      B.closeReader?.();
      B.openQuestionsSheet(id);
      return true;
    }
    const shown = B.select({ question: id });
    if (shown && state.board.owner.some((q) => q.id === id && q.state === 'open')) B.openQuestionsSheet(id);
    return shown;
  }
  // The pane marks the topic id's row, resolved or not, and focuses it → false while there is no pane or it hasn't loaded.
  function openPaneTopic(id) {
    if (!questions?.B.openTopic(id)) return false;
    const row = questions.slot.querySelector('.wrow[aria-current="true"]');
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
    return true;
  }

  fitPane();
  B.on(wide, 'change', fitPane);
  B.atUnmount(() => { questions?.unmount(); questions = null; });

  Object.assign(B, { renderPane, focusQuestion, openPaneTopic });
});
