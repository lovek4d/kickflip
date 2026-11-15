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
  // The anchor is the field being typed in, else the title row of the open card on screen, else the first card on screen
  // that is still in its lane after the paint, since a card that changed lane is the one leaving
  // (docs/adr/2026-11-15-1030-a-card-moving-off-screen-leaves-the-visible-cards-where-they-were.md). A field in a
  // dialog doesn't move with the page, so the card anchors then.
  const topOf = (el) => el.getBoundingClientRect().top;
  // → the anchors in order of preference, each its place on screen and a function finding it again after a repaint.
  function anchorsOf() {
    const field = focusedField();
    if (field && !field.closest('dialog')) { const find = finder(field); return [{ find, top: topOf(find()) }]; }
    const open = [...B.$$('details.item[open]')].find((d) => { const r = d.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    if (open) {
      const title = `details.item[data-key="${CSS.escape(open.dataset.key)}"] > summary`;
      return [{ find: () => $(title), top: topOf($(title)) }];
    }
    return [...B.$$('details.item')].filter((d) => topOf(d) >= 0 && topOf(d) < innerHeight).map((d) => {
      const card = `details.item[data-key="${CSS.escape(d.dataset.key)}"]`;
      const lane = d.closest('details.lane')?.dataset.lane;
      return { find: () => { const again = $(card); return again?.closest('details.lane')?.dataset.lane === lane ? again : null; }, top: topOf(d) };
    });
  }
  function steady(paint) {
    const anchors = anchorsOf();
    keepFocus(paint);
    for (const { find, top } of anchors) {
      const el = find();
      if (!el) continue;
      const after = topOf(el);
      if (after !== top) scrollBy(0, after - top);
      return;
    }
  }
  // Runs change, which grows or shrinks a thread above its reply form, and scrolls the page by the form's move so the
  // form, and every message below the change, stays where it was on screen: the page above takes the height
  // (docs/adr/2026-11-15-1600-expanding-in-a-thread-grows-it-upward.md).
  function holdBelow(thread, change) {
    const form = thread.querySelector('form[data-reply]');
    const top = topOf(form);
    change();
    const after = topOf(form);
    if (after !== top) scrollBy(0, after - top);
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
