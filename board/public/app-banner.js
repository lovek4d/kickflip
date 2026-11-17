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

  Object.assign(B, { renderBanner, renderStart });
});
