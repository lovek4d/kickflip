// The board view's shared helpers, which the other parts take from B. Register it first, after app.js.
BoardView.part((B) => {
  const { $, store, state } = B;

  // Runs paint, a repaint through ui.js setHTML, then gives the field being typed in its focus and cursor back. setHTML
  // keeps that field's node, but moves it with a card that changes lanes, which blurs it, and a box drawn anew (an edit
  // box from state.edits, a reply box from its draft) is found by its form. A card that moved into a closed lane or
  // fold opens it, since a field there can't take focus, and focus scrolls the field into view.
  function keepFocus(paint) {
    const a = document.activeElement;
    const field = a && B.root.contains(a) && a.matches('textarea, input') ? a : null;
    const form = field?.closest('form[data-reply], form[data-edit-form]');
    const again = !form ? null : form.dataset.reply != null ? `form[data-reply="${CSS.escape(form.dataset.reply)}"] textarea`
      : `form[data-edit-form="${CSS.escape(form.dataset.editForm)}"] textarea`;
    const sel = field ? [field.selectionStart, field.selectionEnd, field.selectionDirection] : null;
    paint();
    if (!field || document.activeElement === field) return;
    const el = field.isConnected ? field : again && $(again);
    if (!el) return;
    for (let d = el.closest('details:not([open])'); d; d = d.closest('details:not([open])')) d.open = true;
    el.focus();
    if (sel[0] != null) el.setSelectionRange(...sel);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // A card this browser has never seen starts from now, so a first load badges nothing.
  const seen = store.get('seenThreads', {});
  const latestOf = (it) => [new Date().toISOString(), ...(it?.othersAt || [])].sort().pop();
  function markSeen(it, onlyNew = false) {
    if (!it || (onlyNew && seen[it.key])) return;
    seen[it.key] = latestOf(it);
    store.set('seenThreads', seen);
  }

  // A toast with no ms stays until toast('') clears it, and comes back when a timed toast over it ends.
  let toastTimer = null;
  let sticky = '';
  function toast(html, ms) {
    const t = $('#toast');
    if (!ms) {
      sticky = html;
      if (toastTimer) return;
    } else {
      toastTimer?.();
      toastTimer = B.later(ms, () => { toastTimer = null; t.innerHTML = sticky; t.hidden = !sticky; });
    }
    t.innerHTML = html;
    t.hidden = !html;
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

  // A deleted ask is hidden on the server, so it leaves every device (docs/adr/0008-dismissals-hide-on-the-server.md).
  const hide = (id, hidden) => fetch(B.site.url('api/hide'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, hidden }) });
  // The ui-links.js linkContext for text shown on item `key`'s card or thread.
  const links = (key) => BoardUI.linkContext(state.board?.items || [], key);
  const svg = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const { confirm, notice } = globalThis.BoardDialogs;

  Object.assign(B, { keepFocus, plural, seen, markSeen, toast, quieted, sendDraft, hide, links, svg, confirm, notice });
});
