// The answer banner at the top of the board view: asks Claude answered without making work, whose answer came after the
// card's read mark (domain.mjs answers; docs/adr/2026-10-29-1639-every-ask-is-a-card.md,
// docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md). An ask merged into another card shows in the New strip
// (app-asks.js; docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md).
// Needs app-core.js.
BoardView.part((B) => {
  const { $, state, seen, markSeen, markRead, plural, svg } = B;
  const { esc } = BoardUI;

  const unseen = (list) => (list || []).filter((a) => seen[a.key] && a.at > seen[a.key]);
  // Newest first.
  const unseenAnswers = (d) => unseen(d.answers).sort((a, b) => b.at.localeCompare(a.at));

  function renderBanner(d) {
    const shown = unseenAnswers(d);
    const el = $('#answers');
    el.hidden = !shown.length;
    if (!shown.length) { el.innerHTML = ''; return; }
    const [newest] = shown;
    const more = shown.length > 1 ? `<span class="more"> and ${shown.length - 1} more</span>` : '';
    const head = plural(shown.length, 'answer');
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

  // docs/adr/2026-11-17-0254-a-new-board-opens-empty-while-its-orchestrator-starts.md
  // The start banner over a New board the hub serves while its orchestrator starts (ui-sidebar.js startBanner), drawn
  // from the sidebar's data on each of its copies (app-header.js renderStatus), so it goes once the session joins.
  function renderStart() {
    const el = $('#startBanner');
    const html = BoardUI.startBanner(B.starting?.());
    el.hidden = !html;
    BoardUI.setHTML(el, html);
  }
  // Its taps, as the sidebar's starting row takes them (sidebar.js startTap): Retry starts the board again, and an
  // answer goes to the prompt its session waits on. The tapped button waits until the hub answers; a prompt already
  // answered or gone is done, and any other refusal shows as a toast. The hub's next sidebar copy redraws the banner.
  B.on($('#startBanner'), 'click', async (ev) => {
    const button = ev.target.closest('[data-start-retry], [data-start-answer], [data-start-option]');
    if (!button) return;
    const prompt = button.closest('[data-start-prompt]');
    const url = prompt ? `/_hub/prompts/${encodeURIComponent(prompt.dataset.startPrompt)}/answer` : `/_hub/new-board/${encodeURIComponent(button.dataset.startRetry)}/retry`;
    const body = button.dataset.startOption !== undefined ? { choice: 'allow', answers: { [button.dataset.startQuestion]: button.dataset.startOption } }
      : prompt ? { choice: button.dataset.startAnswer } : {};
    if (body.choice === 'always' && !(await BoardDialogs.confirm(`Always allow ${button.dataset.startRule} for the rest of this session?`))) return;
    try {
      const response = await BoardUI.waitOn(button, fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { group: $('#startBanner').querySelectorAll('button') });
      if (!response.ok && response.status !== 404 && response.status !== 409) {
        const text = await response.text();
        let refused;
        try { refused = JSON.parse(text).error || text; } catch { refused = text; }
        B.toast(refused || 'Could not send.');
      }
    } catch { B.toast('Could not send. Is the host awake?'); }
  });

  // docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md
  // The chain banner while a card's Linked narrows the board (app-search.js linkedTo): the hub's hold banner
  // (hub.css .hold-banner), in blue as information, reading Linked to the card, its × ending it.
  const X = svg('<path d="M18 6 6 18M6 6l12 12"/>', 16);
  const FILTER = svg('<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>', 16);
  function renderLinked() {
    const el = $('#linkedBanner');
    const linked = B.linkedTo();
    el.hidden = !linked;
    if (!linked) { BoardUI.setHTML(el, ''); return; }
    const root = [...state.board.items, ...state.archived.cards, ...state.found.cards].find((c) => c.key === linked.key);
    BoardUI.setHTML(el, `<div class="hold-banner linked" role="status">${BoardUI.LINK}<span>Linked to <b>${esc(root?.ref || linked.key)}</b></span>`
      + `<button type="button" class="btn quiet" data-linked-end aria-label="Show every card" title="Show every card (Esc)">${X}</button></div>`);
  }

  // docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
  // The filter banner while any filter box is unchecked: the chain banner's style, under it when a chain is on too,
  // reading the checked boxes' names and how many of the board's cards the filter hides, its × resetting the filter.
  function renderFilterBanner() {
    const el = $('#filterBanner');
    const off = state.boardFilter;
    el.hidden = !off.length;
    if (!off.length) { BoardUI.setHTML(el, ''); return; }
    const showing = BoardUI.FILTER_BOXES.filter((box) => !off.includes(box.id)).map((box) => box.name);
    const hidden = state.board.items.filter((it) => !it.isNew && BoardUI.filterHides(it, off)).length;
    BoardUI.setHTML(el, `<div class="hold-banner linked" role="status">${FILTER}<span>Showing <b>${esc(showing.join(', ') || 'nothing')}</b> · ${hidden} hidden</span>`
      + `<button type="button" class="btn quiet" data-filter-end aria-label="Reset the filter" title="Reset the filter">${X}</button></div>`);
  }
  B.on(B.root, 'click', (ev) => { if (ev.target.closest?.('[data-filter-end]')) B.clearFilter(); });

  // docs/adr/2026-11-22-0300-a-tag-chip-narrows-the-board-under-its-own-banner.md
  // The tag banner while a tag chip narrows the board (app-search.js showTag): the chain banner's style, under it,
  // reading the tag and how many cards the page holds that carry it, its × ending the tag.
  const TAG = svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>', 16);
  function renderTagBanner() {
    const el = $('#tagBanner');
    const name = B.taggedName();
    el.hidden = name === null;
    if (name === null) { BoardUI.setHTML(el, ''); return; }
    BoardUI.setHTML(el, `<div class="hold-banner linked" role="status">${TAG}<span>Tag: <b>${esc(name)}</b> · ${plural(B.taggedCards().length, 'card')}</span>`
      + `<button type="button" class="btn quiet" data-tag-end aria-label="Show every card" title="Show every card (Esc)">${X}</button></div>`);
  }

  Object.assign(B, { renderBanner, renderStart, renderLinked, renderTagBanner, renderFilterBanner });
});
