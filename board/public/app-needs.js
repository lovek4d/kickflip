// The board page's Needs you box: one line per thing waiting on the owner (domain.mjs needsOf). Needs app-core.js.
(function () {
  const B = globalThis.BoardApp;
  const { $, plural } = B;
  const { esc } = BoardUI;

  function renderNeeds(d) {
    const parts = (line) => [
      line.questions ? `<a href="${esc(line.questions.url)}">${plural(line.questions.open, 'question')}</a>` : '',
      line.ready ? `<a href="${esc(line.ready)}" target="_blank" rel="noopener">Ready on GitHub</a>` : '',
      line.action ? `<a href="${esc(line.action.url)}">${esc(line.action.label)}</a>` : '',
    ].filter(Boolean).join(' · ');
    const needs = d.needs || [];
    const w = $('#waiting');
    w.hidden = needs.length === 0;
    w.innerHTML = needs.length ? `<h2 style="margin:0 0 6px">Needs you · ${needs.length}</h2>
      <ul>${needs.map((line) => line.key
        ? `<li><a href="${esc(line.url)}">${esc(line.title)}</a> <span class="muted small">· ${parts(line)}</span></li>`
        : `<li><a href="${esc(line.url)}">${esc(line.title)}</a> <span class="muted small">${plural(line.questions.open, 'question')}</span></li>`).join('')}</ul>` : '';
  }

  Object.assign(B, { renderNeeds });
})();
