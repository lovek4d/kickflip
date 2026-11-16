// The board view's shared helpers, which the other parts take from B. Register it first, after app.js.
BoardView.part((B) => {
  const { $, store, state } = B;

  const focusedField = () => {
    const a = document.activeElement;
    return a && B.root.contains(a) && a.matches('textarea, input') ? a : null;
  };
  // → the selector of field's box as drawn anew (an edit box from state.edits, a reply box from its draft), by its form;
  // null for any other field.
  function boxOf(field) {
    const form = field.closest('form[data-reply], form[data-edit-form]');
    return !form ? null : form.dataset.reply != null ? `form[data-reply="${CSS.escape(form.dataset.reply)}"] textarea`
      : `form[data-edit-form="${CSS.escape(form.dataset.editForm)}"] textarea`;
  }
  // → a function finding field after a repaint: the same node, else the box drawn anew in its place.
  function finder(field) {
    const again = boxOf(field);
    return () => (field.isConnected ? field : again && $(again));
  }

  // Runs paint, a repaint through ui.js setHTML, then gives the field being typed in its focus and cursor back when it
  // lost them, which setHTML avoids for a node it moves. A card that moved into a closed lane or fold opens it, since a
  // field there can't keep focus. Refocusing doesn't scroll: steady does.
  function keepFocus(paint) {
    const field = focusedField();
    const find = field && finder(field);
    const sel = field ? [field.selectionStart, field.selectionEnd, field.selectionDirection] : null;
    paint();
    const el = find?.();
    if (!el) return;
    for (let d = el.closest('details:not([open])'); d; d = d.closest('details:not([open])')) d.open = true;
    if (document.activeElement === el) return;
    el.focus({ preventScroll: true });
    if (sel[0] != null) el.setSelectionRange(...sel);
  }

  // Runs paint through keepFocus and keeps the anchor where it was on screen, scrolling the page by however far it
  // moved, in the same task so nothing visibly jumps (docs/adr/2026-10-30-1637-an-open-card-moves-at-once-and-the-page-follows-it.md).
  // The anchor is the field being typed in, else the topmost card on screen that is still in its lane after the paint,
  // since a card that changed lane is the one leaving
  // (docs/adr/2026-11-15-1030-a-card-moving-off-screen-leaves-the-visible-cards-where-they-were.md), else, when no card
  // on screen kept its lane, the topmost of them still shown, which the page follows to its new place
  // (docs/adr/2026-11-16-0916-the-topmost-card-on-screen-stays-put-through-any-reorder-or-resize.md). A field in a
  // dialog doesn't move with the page, so the cards anchor then.
  const topOf = (el) => el.getBoundingClientRect().top;
  const laneOf = (card) => card.closest('details.lane')?.dataset.lane;
  // On screen: any part of the card's box is in the viewport. A card in a closed lane or fold has an empty box.
  const onScreen = (card) => { const r = card.getBoundingClientRect(); return r.bottom > Math.max(r.top, 0) && r.top < innerHeight; };
  // → a function finding card key after a repaint while it shows, in lane when lane is given.
  const findCard = (key, lane) => () => {
    const card = $(`details.item[data-key="${CSS.escape(key)}"]`);
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return r.bottom > r.top && (lane === undefined || laneOf(card) === lane) ? card : null;
  };
  function fieldAnchor() {
    const field = focusedField();
    return field && !field.closest('dialog') ? { find: finder(field), top: topOf(field) } : null;
  }
  // → the anchors in order of preference, each its place on screen and a function finding it again after a repaint.
  function anchorsOf() {
    const field = fieldAnchor();
    if (field) return [field];
    const cards = [...B.$$('details.item')].filter(onScreen);
    return [...cards.map((d) => ({ find: findCard(d.dataset.key, laneOf(d)), top: topOf(d) })),
      ...cards.map((d) => ({ find: findCard(d.dataset.key), top: topOf(d) }))];
  }
  // The anchor between repaints: the field being typed in, else the topmost card on screen, wherever it goes. Taken
  // again after each steady and holdBelow, and on each scroll, so the owner's own scrolling moves it.
  function anchorNow() {
    const field = fieldAnchor();
    if (field) return field;
    const card = [...B.$$('details.item')].find(onScreen);
    return card ? { find: findCard(card.dataset.key), top: topOf(card) } : null;
  }
  // anchor, and the page's scroll it was taken at or held to. A scroll event at that same scroll moved nothing: Chrome
  // sends one late, after a size change in the same frame, so taking the anchor then would take the shifted layout.
  let anchor = null;
  let anchorY = 0;
  const take = (next) => { anchor = next; anchorY = scrollY; };
  // → whether anchor is still shown, after scrolling the page by however far it moved.
  function hold({ find, top }) {
    const el = find();
    if (!el) return false;
    const after = topOf(el);
    if (after !== top) scrollBy(0, after - top);
    return true;
  }
  function steady(paint) {
    const anchors = anchorsOf();
    keepFocus(paint);
    anchors.some(hold);
    take(anchorNow());
  }
  // A size change on the board outside a repaint (a card or lane opening or shutting, an image loading, a font
  // settling) keeps the anchor in place. An anchor that no longer shows, such as a card in a lane just shut, gives way
  // to the topmost card on screen now.
  const watcher = new ResizeObserver(() => {
    if (!anchor) return;
    if (hold(anchor)) anchorY = scrollY; else take(anchorNow());
  });
  watcher.observe(B.root);
  watcher.observe($('#lanes'));
  B.atUnmount(() => watcher.disconnect());
  B.on(window, 'scroll', () => { if (scrollY !== anchorY) take(anchorNow()); }, { passive: true });
  // A tapped card's, lane's or Done fold's title anchors the change its tap makes, so opening a lane above the topmost
  // card leaves the title where it was tapped. A thread's folds hold their reply form instead (holdBelow).
  B.on(B.root, 'click', (ev) => {
    const title = ev.target.closest?.('details.item > summary, details.lane > summary, details.fold > summary');
    if (title) take({ find: () => (title.isConnected ? title : null), top: topOf(title) });
  }, true);
  // Runs change, which grows or shrinks a thread above its reply form, and scrolls the page by the form's move so the
  // form, and every message below the change, stays where it was on screen: the page above takes the height
  // (docs/adr/2026-11-15-1600-expanding-in-a-thread-grows-it-upward.md).
  function holdBelow(thread, change) {
    const form = thread.querySelector('form[data-reply]');
    const top = topOf(form);
    change();
    const after = topOf(form);
    if (after !== top) scrollBy(0, after - top);
    take(anchorNow());
  }
  // Where the owner left the board, kept for its next mount in this page: the page's scroll and the box they were typing
  // in, as it unmounts or at their last press outside the board, such as on a sidebar row, which takes the focus first.
  // The header's logo, which opens the sidebar, counts as outside.
  let held = null;
  B.on(document, 'pointerdown', (e) => {
    const outside = !B.root.contains(e.target) || e.target.closest?.('.top a.hub');
    held = outside ? focusedField() || held : null;
  }, true);
  // A board left before its first render keeps the place it hadn't returned to yet.
  let place = B.place;
  B.keep(() => {
    if (place) return { y: place.y, box: place.box };
    const field = focusedField() || (held?.isConnected ? held : null);
    const selector = field && boxOf(field);
    return { y: scrollY, box: selector ? { selector, selection: [field.selectionStart, field.selectionEnd, field.selectionDirection], top: field.scrollTop } : null };
  });
  // Only the first call restores, and none when the URL names a card (linked). A phone's keyboard would open for the
  // focus, so only a mouse or trackpad gets the box back (sidebar.js DESKTOP).
  function restorePlace({ linked = false } = {}) {
    const p = place;
    place = null;
    if (!p || linked) return;
    scrollTo(0, p.y);
    const box = p.box && $(p.box.selector);
    if (!box || box.closest('details:not([open])') || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(...p.box.selection);
    box.scrollTop = p.box.top;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Read marks live on the board, one set for every device: each card's readAt, the newest message the owner has seen
  // on it (docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md). seen is card key → the later of the board's mark
  // and this page's own, so a card read here reads at once, before the board comes back with it. seenBefore is an open
  // card's mark from before it opened, where its thread's unread lines start (app-threads.js); a card closing drops it,
  // and a board left and opened again in this page keeps it.
  const seen = Object.create(null);
  const seenBefore = new Map(B.place?.seenBefore);
  B.keep(() => ({ seenBefore: [...seenBefore] }));
  function takeMarks(items) {
    for (const it of items) if (String(it.readAt || '') > (seen[it.key] || '')) seen[it.key] = it.readAt;
  }
  // [[card key, time]] → each card read up to its time, here at once and on the board for every device.
  function markRead(pairs) {
    const marks = Object.fromEntries(pairs.filter(([key, at]) => at && String(at) > (seen[key] || '')));
    if (!Object.keys(marks).length) return;
    Object.assign(seen, marks);
    fetch(B.site.url('api/read'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ marks }) }).catch(() => {});
  }
  // The newest message card it shows: its counted messages (domain.mjs othersAt) and its questions' asks.
  const newestOf = (it) => [...(it.othersAt || []), ...(it.questions?.askedAt || [])].filter(Boolean).map(String).sort().pop();
  // Card it, open, reads up to the newest message it shows.
  function markSeen(it) {
    if (!it) return;
    if (!seenBefore.has(it.key)) seenBefore.set(it.key, seen[it.key] || null);
    markRead([[it.key, newestOf(it)]]);
  }

  // The ui-links.js linkContext for text shown on item `key`'s card or thread.
  const links = (key) => BoardUI.linkContext(state.board?.items || [], key);
  const svg = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const dialogs = globalThis.BoardDialogs;
  const controller = new AbortController();
  B.atUnmount(() => controller.abort());
  const confirm = (message, labels) => dialogs.confirm(message, { ...labels, signal: controller.signal });
  const notice = dialogs.notice;

  Object.assign(B, { steady, holdBelow, restorePlace, plural, seen, seenBefore, takeMarks, markRead, markSeen, links, svg, confirm, notice });
});
