// The header's chip counting the cards and events waiting on the orchestrator, and its sheet listing one row for each
// in the waits file's order (docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md,
// docs/adr/2026-11-16-0856-the-waits-sheet-lists-one-row-per-card-for-what-the-orchestrator-owes-now.md; ui-waits.js
// waitsRows picks the rows and draws both). A
// card's row opens the card. Both repaint each half-minute, so the durations count up between board changes; the colour
// is the server's tone. Needs app-core.js.
BoardView.part((B) => {
  const { $, state } = B;
  const { setHTML, waitsRows, waitsChip, waitsList, waitsTitle } = BoardUI;
  const sheet = $('#waitsSheet');

  function renderWaits(d) {
    const rows = waitsRows(d.orchestratorWaits || []);
    setHTML($('#waitsChip'), waitsChip(rows));
    if (!sheet.open) return;
    if (!rows.length) { sheet.close(); return; }
    $('#waitsTitle').textContent = waitsTitle(rows.length);
    setHTML($('#waitsBody'), waitsList(rows, d.items));
  }

  function openCard(key) {
    sheet.close();
    const hash = `#selectedCard=${encodeURIComponent(key)}`;
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  }

  B.on($('#waitsChip'), 'click', (ev) => {
    if (!ev.target.closest('[data-waits]') || !state.board || sheet.open || !waitsRows(state.board.orchestratorWaits || []).length) return;
    BoardUI.openSheet(sheet);
    renderWaits(state.board);
  });
  B.every(30000, () => { if (!document.hidden && state.board) renderWaits(state.board); });
  B.atUnmount(BoardUI.swipeToDismiss(sheet));
  B.on(sheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, sheet) || ev.target.closest('#waitsClose')) { sheet.close(); return; }
    const open = ev.target.closest('[data-wait-open]');
    if (open) openCard(open.dataset.waitOpen);
  });

  Object.assign(B, { renderWaits });
});
