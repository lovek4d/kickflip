// docs/adr/2026-11-17-0613-a-search-bar-narrows-the-board-as-you-type.md
// The board search: the bar under the header that the header's magnifier, f pressed twice or / opens. As the owner types,
// the New strip, Auto Review and every lane keep only the tasks holding every word (ui-cards.js searchWords and
// cardMatches; app-lanes.js, app-asks.js), and Done also fetches the archive's matches (app-lanes.js findArchived). Enter opens the top match on a desktop; on a phone the keyboard's Search key,
// or a drag on the page, hides the keyboard and keeps the filter. Esc or the × clears the search and closes the bar. The
// words live in memory only, so a reload ends the search. The card chain filter, a card menu's Linked, lives here too
// (below). Needs app-core.js, app.js's render and app-selection.js's select.
BoardView.part((B) => {
  const { $, state } = B;
  const bar = $('#searchBar');
  const field = $('#searchField');
  const opener = $('#searchOpen');
  let words = [];
  const searchWords = () => words;
  const draw = () => { if (state.board) B.render(); };
  const desktop = () => matchMedia('(min-width: 900px)').matches;

  function openSearch() {
    bar.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    field.focus({ preventScroll: true });
  }
  function endSearch() {
    field.value = '';
    field.blur();
    bar.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    if (!words.length) return;
    words = [];
    B.findArchived(words);
    draw();
  }
  B.on(B.root, 'input', (ev) => {
    if (ev.target !== field) return;
    const next = BoardUI.searchWords(field.value);
    if (next.join(' ') === words.join(' ')) return;
    words = next;
    B.findArchived(words);
    draw();
  });
  B.on(B.root, 'click', (ev) => {
    if (ev.target.closest?.('#searchOpen')) { ev.preventDefault(); openSearch(); }
    else if (ev.target.closest?.('[data-search-clear]')) endSearch();
  });

  // The top match: the New strip's first entry, else the first card down the lanes, Auto Review leading them. A card or
  // a New entry with a card opens as a pick does; a PR's review opens in Auto Review.
  function openTop() {
    const top = $('#newStrip .new-entry[data-new]') || $('#lanes details.rv-card, #lanes details.rv-line, #lanes details.item');
    if (!top) return;
    if (top.dataset.review) B.openReview(Number(top.dataset.review));
    else if (top.dataset.key) B.select(top.dataset.key);
    else { top.scrollIntoView({ block: 'center' }); B.highlight(top); }
  }

  // f twice within TWICE_MS, or /, opens the bar, as n twice opens New task (new-task.js): never from a text box, with a
  // modifier, over a dialog or a board that is down or hidden, nor from a key switch mode used (sidebar.js), which comes
  // defaultPrevented. Any other key between the two f's starts the pair again.
  const TWICE_MS = 500;
  let lastF = -Infinity;
  const inField = (el) => el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const blocked = (ev) => B.root.classList.contains('down') || ev.target?.closest?.('dialog') || $('dialog[open]');
  B.on(document, 'keydown', (ev) => {
    if (ev.target === field) {
      if (ev.key === 'Escape') { ev.preventDefault(); endSearch(); }
      else if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        field.blur();
        if (desktop()) openTop();
      }
      return;
    }
    if (ev.key === 'Escape') {
      if (ev.defaultPrevented || inField(ev.target) || blocked(ev)) return;
      if (!bar.hidden) endSearch();
      else endLinked();
      return;
    }
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || ev.isComposing
      || (ev.key !== 'f' && ev.key !== '/') || inField(ev.target) || blocked(ev)) { lastF = -Infinity; return; }
    if (ev.key === 'f' && ev.timeStamp - lastF > TWICE_MS) { lastF = ev.timeStamp; return; }
    lastF = -Infinity;
    ev.preventDefault();
    openSearch();
  });
  // iOS keeps the fixed bar on the layout viewport, so while the field has focus --kb, measured as dialogs.js fitSheet
  // does, lifts the bar above the keyboard (style.css .search-bar).
  const vv = window.visualViewport;
  const fitKeyboard = () => bar.style.setProperty('--kb', (vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0) + 'px');
  B.on(field, 'focus', () => {
    fitKeyboard();
    vv?.addEventListener('resize', fitKeyboard);
    vv?.addEventListener('scroll', fitKeyboard);
  });
  B.on(field, 'blur', () => {
    vv?.removeEventListener('resize', fitKeyboard);
    vv?.removeEventListener('scroll', fitKeyboard);
    bar.style.removeProperty('--kb');
  });
  // A drag on the page while the search has the keyboard hides it, keeping the filter.
  B.on(document, 'touchmove', (ev) => {
    if (document.activeElement === field && !bar.contains(ev.target)) field.blur();
  }, { passive: true });

  // docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md
  // A card's Linked · 1 hop or Linked · all (its "…" menu, app-cards.js) narrows the lanes to the card's chain
  // (ui-cards.js linkedKeys) over every card the page holds: the board's, Done's archive pages and the search's archive
  // matches. Choosing again on any card re-roots it there. The banner's × or Esc (once the search bar is closed) ends
  // it. Like the words, it lives in memory only.
  let linked = null;
  const linkedTo = () => linked;
  function linkedKeys() {
    if (!linked) return null;
    const byKey = new Map([...state.found.cards, ...state.archived.cards, ...state.board.items].map((c) => [c.key, c]));
    return BoardUI.linkedKeys(byKey, linked.key, linked.depth);
  }
  function showLinked(key, depth) {
    linked = { key, depth };
    draw();
  }
  function endLinked() {
    if (!linked) return;
    linked = null;
    draw();
  }
  B.on(B.root, 'click', (ev) => { if (ev.target.closest?.('[data-linked-end]')) endLinked(); });

  Object.assign(B, { searchWords, endSearch, linkedTo, linkedKeys, showLinked, endLinked });
});
