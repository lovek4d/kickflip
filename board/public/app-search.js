// docs/adr/2026-11-17-0613-a-search-bar-narrows-the-board-as-you-type.md
// The board search: the bar under the header that the header's magnifier, f pressed twice or / opens. As the owner types,
// the New strip, Auto Review and every lane keep only the tasks holding every word (ui-cards.js searchWords and
// cardMatches; app-lanes.js, app-asks.js). Enter opens the top match on a desktop; on a phone the keyboard's Search key,
// or a drag on the page, hides the keyboard and keeps the filter. Esc or the × clears the search and closes the bar. The
// words live in memory only, so a reload ends the search. Needs app-core.js, app.js's render and app-selection.js's select.
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
    field.focus();
  }
  function endSearch() {
    field.value = '';
    field.blur();
    bar.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    if (!words.length) return;
    words = [];
    draw();
  }
  B.on(B.root, 'input', (ev) => {
    if (ev.target !== field) return;
    const next = BoardUI.searchWords(field.value);
    if (next.join(' ') === words.join(' ')) return;
    words = next;
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
    else if (top.dataset.key) B.select({ card: top.dataset.key });
    else { top.scrollIntoView({ block: 'center' }); B.highlight(top); }
  }

  // f twice within TWICE_MS, or /, opens the bar, as n twice opens New task (new-task.js): never from a text box, with a
  // modifier, over a dialog or a board that is down or hidden, nor from a key switch mode used (sidebar.js), which comes
  // defaultPrevented. Any other key between the two f's starts the pair again.
  const TWICE_MS = 500;
  let lastF = -Infinity;
  const inField = (el) => el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const blocked = (ev) => B.root.hidden || B.root.classList.contains('down') || ev.target?.closest?.('dialog') || $('dialog[open]');
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
      if (!bar.hidden && !ev.defaultPrevented && !inField(ev.target) && !blocked(ev)) endSearch();
      return;
    }
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || ev.isComposing
      || (ev.key !== 'f' && ev.key !== '/') || inField(ev.target) || blocked(ev)) { lastF = -Infinity; return; }
    if (ev.key === 'f' && ev.timeStamp - lastF > TWICE_MS) { lastF = ev.timeStamp; return; }
    lastF = -Infinity;
    ev.preventDefault();
    openSearch();
  });
  // A drag on the page while the search has the keyboard hides it, keeping the filter.
  B.on(document, 'touchmove', (ev) => {
    if (document.activeElement === field && !bar.contains(ev.target)) field.blur();
  }, { passive: true });

  Object.assign(B, { searchWords, endSearch });
});
