// The answer banner at the top of the board view: asks Claude answered without making work, whose answer came after the
// card's read mark (domain.mjs answers; docs/adr/2026-10-29-1639-every-ask-is-a-card.md,
// docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md), and new cards merged into another card since that card's
// read mark (domain.mjs merges; docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md).
// Needs app-core.js.
BoardView.part((B) => {
  const { $, state, seen, markSeen, markRead, plural, svg } = B;
  const { esc } = BoardUI;

  const unseen = (list) => (list || []).filter((a) => seen[a.key] && a.at > seen[a.key]);
  // Newest first: each unseen answer, and each unseen merge marked merged.
  const unseenAnswers = (d) => [...unseen(d.answers), ...unseen(d.merges).map((m) => ({ ...m, merged: true }))].sort((a, b) => b.at.localeCompare(a.at));

  function renderBanner(d) {
    const shown = unseenAnswers(d);
    const el = $('#answers');
    el.hidden = !shown.length;
    if (!shown.length) { el.innerHTML = ''; return; }
    const [newest] = shown;
    const more = shown.length > 1 ? `<span class="more"> and ${shown.length - 1} more</span>` : '';
    const head = newest.merged ? `Merged into ${esc(newest.ref)}` : plural(shown.filter((a) => !a.merged).length, 'answer');
    el.innerHTML = `<button type="button" class="answer-open" data-answer="${esc(newest.key)}">
        <strong>${head}</strong><span class="sep"> · </span><span class="text">${esc(newest.text)}</span>${more}
      </button>
      <button type="button" class="ghost icon answer-dismiss" aria-label="Dismiss" title="Dismiss">${svg('<path d="M18 6 6 18M6 6l12 12"/>', 16)}</button>`;
  }

  B.on($('#answers'), 'click', (ev) => {
    const d = state.board;
    if (!d) return;
    // ✕ marks each answer shown read, on every device.
    if (ev.target.closest('.answer-dismiss')) {
      markRead(unseenAnswers(d).map((a) => [a.key, a.at]));
      renderBanner(d);
      return;
    }
    const open = ev.target.closest('[data-answer]');
    if (!open) return;
    const key = open.dataset.answer;
    markSeen(d.items.find((i) => i.key === key));
    const hash = `#selectedCard=${encodeURIComponent(key)}`;
    if (location.hash === hash) history.replaceState(null, '', location.pathname + location.search);
    location.hash = hash;
  });

  Object.assign(B, { renderBanner });
});
