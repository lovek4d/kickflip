// The board view's Needs you box: one line per thing waiting on the owner (domain.mjs needsOf), led by the board
// session's pending prompts, answered in place (prompts.js). Needs app-core.js.
BoardView.part((B) => {
  const { $, plural, state, toast } = B;
  const { esc, promptItem } = BoardUI;

  const prompts = PromptAnswers.wire(B, {
    list: () => (state.board?.needs || []).filter((line) => line.prompt).map((line) => line.prompt),
    paint: () => { if (state.board) renderNeeds(state.board); },
    notify: (text) => toast(esc(text), 3000),
    after: () => B.loadBoard(),
  });

  function renderNeeds(d) {
    const parts = (line) => [
      line.questions ? `<a href="${esc(line.questions.url)}">${plural(line.questions.open, 'question')}</a>` : '',
      line.ready ? `<a href="${esc(line.ready)}" target="_blank" rel="noopener">Ready on GitHub</a>` : '',
      line.action ? `<a href="${esc(line.action.url)}">${esc(line.action.label)}</a>` : '',
    ].filter(Boolean).join(' · ');
    const needs = (d.needs || []).filter((line) => !line.prompt || prompts.shows(line.prompt));
    const w = $('#waiting');
    w.hidden = needs.length === 0;
    w.innerHTML = needs.length ? `<h2 style="margin:0 0 6px">Needs you · ${needs.length}</h2>
      <ul>${needs.map((line) => (line.prompt ? promptItem(line.prompt, prompts.state(line.prompt))
        : line.key ? `<li><a href="${esc(line.url)}">${esc(line.title)}</a> <span class="muted small">· ${parts(line)}</span></li>`
          : `<li><a href="${esc(line.url)}">${esc(line.title)}</a> <span class="muted small">${plural(line.questions.open, 'question')}</span></li>`)).join('')}</ul>` : '';
  }

  Object.assign(B, { renderNeeds });
});
