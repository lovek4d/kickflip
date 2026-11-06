// The progress bar every bar on the board draws from: an In Progress card's five build phases and a Todo card's planner
// dashes (ui-cards.js), and a starting board's three start steps (ui-sidebar.js)
// (docs/adr/2026-11-06-0038-a-progress-bar-pulses-one-step-at-a-time.md). It needs nothing else, since hub/hub.mjs
// renders the shell's first sidebar with it in a vm context. style.css draws the bars.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // {count, done, now, percent, dim, tone, label}, or null for no bar. done counts the steps reached, filled; now is the
  // index of the one step still running, which pulses, so no bar can draw two. percent fills the step after the done
  // ones that far. A dim bar draws its running step filled, without the pulse. tone is a lane class, 'in-todo' drawing it in
  // Todo's grey; with none it is In Progress's orange.
  function progressBar(bar) {
    if (!bar) return '';
    const { count, done, now, percent, dim, tone, label } = bar;
    const step = (i) => (i === now ? `<i class="${dim ? 'done' : 'now'}"></i>` : i < done ? '<i class="done"></i>'
      : i === done && percent !== undefined ? `<i class="fill" style="--p:${percent}%"></i>` : '<i class=""></i>');
    return `<span class="phase-bars${dim ? ' dim' : ''}${tone ? ` ${tone}` : ''}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${Array.from({ length: count }, (_, i) => step(i)).join('')}</span>`;
  }
  // Every pulse on the page beats on one clock: each one that starts is set to the document timeline's origin, so a
  // card's running step and its status dot blink together, and a redraw that draws a new copy never restarts the beat.
  const PULSES = new Set(['pulse', 'pulse-fill', 'sb-pulse', 'reader-pulse']);
  function onePulse(ev) {
    if (!PULSES.has(ev.animationName)) return;
    for (const a of ev.target.getAnimations()) if (a.animationName === ev.animationName) a.startTime = 0;
  }
  Object.assign(globalThis.BoardUI ||= {}, { progressBar, onePulse });
  // hub/hub.mjs runs this with no document, only to render the sidebar.
  globalThis.document?.addEventListener('animationstart', onePulse);
})();
