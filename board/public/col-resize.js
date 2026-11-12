// Drag-resizing of the sidebar rail on a desktop (docs/adr/2026-11-10-1600-the-desktop-columns-drag-and-this-device-keeps-their-widths.md).
// The `.col-handle[data-col="sidebar"]` drags the rail's edge. Its width is clamped to 220–420px, kept per device for
// every board, and set on <html> as --sb-w, which style.css and sidebar.css read. A double-click on the handle forgets
// the width; ←/→ on the focused handle moves it 16px. Loaded after the body's first elements so the stored width lands
// before the first paint of the board.
(function () {
  const KEY = 'hub:sidebarWidth';
  const VAR = '--sb-w';
  const MIN = 220, MAX = 420, STEP = 16;
  const html = document.documentElement;
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode or full: kept for this page only */ } };
  const forget = () => { try { localStorage.removeItem(KEY); } catch { /* nothing kept */ } };
  const stored = () => { const n = Number(read()); return Number.isFinite(n) && n > 0 ? n : null; };

  const clamp = (px) => Math.min(MAX, Math.max(MIN, px));
  function paint() {
    const px = stored();
    if (px === null) html.style.removeProperty(VAR);
    else html.style.setProperty(VAR, `${clamp(px)}px`);
  }
  function set(px) { write(String(Math.round(px))); paint(); }
  function reset() { forget(); paint(); }
  paint();

  // The width the handle's drag edge is at now.
  const current = (el) => { const edge = el.getBoundingClientRect(); return edge.left + edge.width / 2; };

  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest?.('.col-handle');
    if (!el || !wide() || e.button > 0) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('dragging');
    html.classList.add('col-dragging');
    const move = (m) => set(m.clientX);
    const end = () => { el.classList.remove('dragging'); html.classList.remove('col-dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  document.addEventListener('dblclick', (e) => {
    if (e.target.closest?.('.col-handle') && wide()) reset();
  });
  document.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('.col-handle');
    if (!el || !wide() || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    set((stored() ?? current(el)) + (e.key === 'ArrowRight' ? STEP : -STEP));
  });

  window.ColResize = { clamp, set, reset };
})();
