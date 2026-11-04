// The phase bars: one bar per phase, those reached filled, a running one pulsing. An In Progress card draws the five
// build phases (ui-cards.js) and a starting board's sidebar row its three start steps (ui-sidebar.js)
// (docs/adr/2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md). It needs nothing else, since
// hub/hub.mjs renders the shell's first sidebar with it in a vm context. style.css draws the bars.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // strip: {reached, running, dim, label, fill}, or null for no bars. reached counts the phases reached, the last of them
  // running when running is set; fill, a percent, fills the next bar that far.
  function phaseBars(strip, phases) {
    if (!strip) return '';
    const { reached, running, dim, label, fill } = strip;
    const bar = (i) => (i === reached - 1 && running ? '<i class="now"></i>' : i < reached ? '<i class="done"></i>'
      : i === reached && fill !== undefined ? `<i class="fill" style="--p:${fill}%"></i>` : '<i class=""></i>');
    return `<span class="phase-bars${dim ? ' dim' : ''}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${phases.map((_, i) => bar(i)).join('')}</span>`;
  }
  Object.assign(globalThis.BoardUI ||= {}, { phaseBars });
})();
