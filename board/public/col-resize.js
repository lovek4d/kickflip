// Drag-resizing of the desktop columns (docs/adr/2026-11-10-1600-the-desktop-columns-drag-and-this-device-keeps-their-widths.md).
// A `.col-handle[data-col="sidebar"|"pane"]` drags its column's edge: the sidebar rail's, or the seam between the lanes
// and the pane. Widths are clamped (sidebar 220–420px, the lanes and the pane each 360px or more), kept
// per device for every board, and set on <html> as --sb-w and --pane-w, which style.css and sidebar.css read. A double-click
// on a handle forgets the width; ←/→ on a focused handle moves it 16px. Loaded after the body's first elements so the
// stored widths land before the first paint of the board.
(function () {
  const KEYS = { sidebar: 'hub:sidebarWidth', pane: 'hub:paneWidth' };
  const VARS = { sidebar: '--sb-w', pane: '--pane-w' };
  const SIDEBAR_MIN = 220, SIDEBAR_MAX = 420, LANE_MIN = 360, STEP = 16, DEFAULT_SIDEBAR = 272;
  const html = document.documentElement;
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode or full: kept for this page only */ } };
  const forget = (k) => { try { localStorage.removeItem(k); } catch { /* nothing kept */ } };
  const stored = (col) => { const n = Number(read(KEYS[col])); return Number.isFinite(n) && n > 0 ? n : null; };
  // The sidebar's width now, which the pane's room depends on.
  const sidebarNow = (viewport) => (html.classList.contains('sb-collapsed') ? 0 : clamp('sidebar', stored('sidebar') ?? DEFAULT_SIDEBAR, viewport, 0));

  // → px clamped for the column: the pane's ceiling leaves the lanes their minimum beside the sidebar, and its floor
  // wins where the window is too narrow for both.
  function clamp(col, px, viewport, sidebarW) {
    if (col === 'sidebar') return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px));
    return Math.max(LANE_MIN, Math.min(px, viewport - sidebarW - LANE_MIN));
  }
  function paint(col) {
    const px = stored(col);
    if (px === null) { html.style.removeProperty(VARS[col]); return; }
    html.style.setProperty(VARS[col], `${col === 'pane' ? clamp('pane', px, window.innerWidth, sidebarNow(window.innerWidth)) : clamp('sidebar', px)}px`);
  }
  function paintAll() { paint('sidebar'); paint('pane'); }
  function set(col, px) { write(KEYS[col], String(Math.round(px))); paintAll(); }
  function reset(col) { forget(KEYS[col]); paintAll(); }
  paintAll();
  window.addEventListener('resize', paintAll);

  // The width a handle's drag edge is at now, and the width the pointer at x asks for.
  const current = (col, el) => {
    const edge = el.getBoundingClientRect();
    return col === 'sidebar' ? edge.left + edge.width / 2 : window.innerWidth - (edge.left + edge.width / 2);
  };
  const wanted = (col, x) => (col === 'sidebar' ? x : window.innerWidth - x);

  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest?.('.col-handle');
    if (!el || !wide() || e.button > 0) return;
    const col = el.dataset.col;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('dragging');
    html.classList.add('col-dragging');
    const move = (m) => set(col, wanted(col, m.clientX));
    const end = () => { el.classList.remove('dragging'); html.classList.remove('col-dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  document.addEventListener('dblclick', (e) => {
    const el = e.target.closest?.('.col-handle');
    if (el && wide()) reset(el.dataset.col);
  });
  document.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('.col-handle');
    if (!el || !wide() || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const col = el.dataset.col;
    e.preventDefault();
    // → grows the sidebar and shrinks the pane, as the edge moves right.
    const dx = (e.key === 'ArrowRight' ? STEP : -STEP) * (col === 'sidebar' ? 1 : -1);
    set(col, (stored(col) ?? current(col, el)) + dx);
  });

  window.ColResize = { clamp, set, reset };
})();
