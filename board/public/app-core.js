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
  // The anchor is the field being typed in, else the title row of the open card on screen, else there is none. A field
  // in a dialog doesn't move with the page, so the card anchors then.
  function anchorOf() {
    const field = focusedField();
    if (field && !field.closest('dialog')) return finder(field);
    const card = [...B.$$('details.item[open]')].find((d) => { const r = d.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    if (!card) return null;
    const title = `details.item[data-key="${CSS.escape(card.dataset.key)}"] > summary`;
    return () => $(title);
  }
  function steady(paint) {
    const find = anchorOf();
    const before = find?.()?.getBoundingClientRect().top;
    keepFocus(paint);
    const after = before == null ? null : find()?.getBoundingClientRect().top;
    if (after != null && after !== before) scrollBy(0, after - before);
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

  // A card this browser has never seen starts from now, so a first load badges nothing.
  const seen = Object.assign(Object.create(null), store.get('seenThreads', {}));
  const latestOf = (it) => [new Date().toISOString(), ...(it?.othersAt || [])].sort().pop();
  function markSeen(it, onlyNew = false) {
    if (!it || (onlyNew && seen[it.key])) return;
    seen[it.key] = latestOf(it);
    store.set('seenThreads', seen);
  }

  // iOS commits a pending predictive-text word after Send clears the box, which would refill it and resave the draft.
  // So Send blurs first, and input is dropped while the send runs and for a moment after it succeeds.
  const quiet = new Map();
  function quieted(draftKey, ta) {
    const until = quiet.get(draftKey) || 0;
    if (until <= Date.now()) return false;
    if (until !== Infinity) ta.value = '';
    return true;
  }
  async function sendDraft(draftKey, ta, current, send) {
    ta.blur();
    quiet.set(draftKey, Infinity);
    try { await send(); } catch (e) { quiet.delete(draftKey); store.set(draftKey, (current() || ta).value); throw e; }
    store.set(draftKey, '');
    const now = current();
    if (now) now.value = '';
    quiet.set(draftKey, Date.now() + 1000);
  }

  // A deleted ask is hidden on the server, so it leaves every device (docs/adr/2026-10-29-1639-dismissals-hide-on-the-server.md).
  const hide = (id, hidden) => fetch(B.site.url('api/hide'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, hidden }) });
  // The ui-links.js linkContext for text shown on item `key`'s card or thread.
  const links = (key) => BoardUI.linkContext(state.board?.items || [], key);
  const svg = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const dialogs = globalThis.BoardDialogs;
  const controller = new AbortController();
  B.atUnmount(() => controller.abort());
  const confirm = (message, labels) => dialogs.confirm(message, { ...labels, signal: controller.signal });
  const notice = dialogs.notice;

  Object.assign(B, { steady, restorePlace, plural, seen, markSeen, quieted, sendDraft, hide, links, svg, confirm, notice });
});
