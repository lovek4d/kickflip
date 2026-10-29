// The answer banner at the top of the board page: asks Claude answered without making work, whose answer this
// browser hasn't seen (domain.mjs answers; docs/adr/0016-every-ask-is-a-card.md). Needs app-core.js.
(function () {
  const B = globalThis.BoardApp;
  const { $, store, state, seen, markSeen, plural, svg } = B;
  const { esc } = BoardUI;
  const DISMISSED = 'dismissedAnswers';

  function unseenAnswers(d) {
    const dismissed = store.get(DISMISSED, {});
    return (d.answers || []).filter((a) => seen[a.key] && a.at > seen[a.key] && !(dismissed[a.id] >= a.at) && !state.withdrawnAsks.has(a.id));
  }

  function renderBanner(d) {
    // A New card seen before its answer counts the answer as new; one first seen in Done starts from now (app-core.js markSeen).
    for (const it of d.items) if (it.isNew) markSeen(it, true);
    const shown = unseenAnswers(d);
    const el = $('#answers');
    el.hidden = !shown.length;
    if (!shown.length) { el.innerHTML = ''; return; }
    const [newest] = shown;
    const more = shown.length > 1 ? `<span class="more"> and ${shown.length - 1} more</span>` : '';
    el.innerHTML = `<button type="button" class="answer-open" data-answer="${esc(newest.key)}">
        <strong>${plural(shown.length, 'answer')}</strong><span class="sep"> · </span><span class="text">${esc(newest.text)}</span>${more}
      </button>
      <button type="button" class="ghost icon answer-dismiss" aria-label="Dismiss" title="Dismiss">${svg('<path d="M18 6 6 18M6 6l12 12"/>', 16)}</button>`;
  }

  $('#answers').addEventListener('click', (ev) => {
    const d = state.board;
    if (!d) return;
    if (ev.target.closest('.answer-dismiss')) {
      const dismissed = store.get(DISMISSED, {});
      for (const a of unseenAnswers(d)) dismissed[a.id] = a.at;
      store.set(DISMISSED, dismissed);
      renderBanner(d);
      return;
    }
    const open = ev.target.closest('[data-answer]');
    if (!open) return;
    const key = open.dataset.answer;
    markSeen(d.items.find((i) => i.key === key));
    const hash = `#item=${encodeURIComponent(key)}`;
    if (location.hash === hash) history.replaceState(null, '', location.pathname + location.search);
    location.hash = hash;
  });

  Object.assign(B, { renderBanner });
})();
