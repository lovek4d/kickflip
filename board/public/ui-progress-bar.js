// The progress bar every bar on the board draws from: an In Progress card's five build phases (ui-cards.js), and a
// starting board's three start steps (ui-sidebar.js)
// (docs/adr/2026-11-06-0038-a-progress-bar-pulses-one-step-at-a-time.md). It needs nothing else, since hub/hub.mjs
// renders the shell's first sidebar with it in a vm context. style.css draws the bars.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // {count, done, now, percent, dim, failed, label}, or null for no bar. done counts the steps reached, filled; now is the
  // index of the one step still running, which pulses, so no bar can draw two. percent fills the step after the done
  // ones that far. A dim bar draws its running step filled, without the pulse. failed is the index of a step that
  // failed, drawn red (a prototype page's landing, prototype-kit.js).
  function progressBar(bar) {
    if (!bar) return '';
    const { count, done, now, percent, dim, failed, label } = bar;
    const step = (i) => (i === failed ? '<i class="failed"></i>' : i === now ? `<i class="${dim ? 'done' : 'now'}"></i>` : i < done ? '<i class="done"></i>'
      : i === done && percent !== undefined ? `<i class="fill" style="--p:${percent}%"></i>` : '<i class=""></i>');
    return `<span class="phase-bars${dim ? ' dim' : ''}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${Array.from({ length: count }, (_, i) => step(i)).join('')}</span>`;
  }
  // Every pulse on the page beats on one clock: each one that starts is set to the document timeline's origin, so a
  // card's running step and its status dot blink together, and a redraw that draws a new copy never restarts the beat.
  const PULSES = new Set(['pulse', 'pulse-fill', 'sb-pulse', 'reader-pulse']);
  function onePulse(ev) {
    if (!PULSES.has(ev.animationName)) return;
    for (const a of ev.target.getAnimations()) if (a.animationName === ev.animationName) a.startTime = 0;
  }
  // How long a live status has been going, in brackets after its word: "(3m)", "(1h 5m)", "(2h)", "(1d 2h)", and nothing
  // under a minute or with no start. Every live status line draws its duration through this; a time of day isn't a
  // duration. It lives here since this file is on every page that draws a status, and in the hub's vm context.
  const liveFor = (since, now = Date.now()) => {
    const m = since ? Math.floor((now - new Date(since).getTime()) / 60000) : 0;
    if (m < 1) return '';
    if (m < 60) return `(${m}m)`;
    const h = Math.floor(m / 60);
    if (h < 24) return `(${h}h${m % 60 ? ` ${m % 60}m` : ''})`;
    return `(${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''})`;
  };
  Object.assign(globalThis.BoardUI ||= {}, { progressBar, onePulse, liveFor });
  // hub/hub.mjs runs this with no document, only to render the sidebar.
  globalThis.document?.addEventListener('animationstart', onePulse);
})();
