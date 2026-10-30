// The sidebar's behaviour on a page with <aside id="sidebar" class="sidebar"> and <div id="sidebarScrim"
// class="sidebar-scrim">, after ui-sidebar.js (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md).
// Sidebar.mount({here, remember, data}) paints the last copy this device stored, then /_hub/sidebar.json, again every
// 30 seconds while the page shows. Below 900px the sidebar is a drawer: the header's logo (a.hub) or a swipe in
// from the left edge opens it, and the scrim, Escape, ✕, the drawer's own logo or a swipe back closes it.
// remember stores `here` as this device's last board, which `/` opens (hub/hub.mjs startPage).
(function () {
  const DATA_KEY = 'hub:sidebar';
  const LAST_KEY = 'hub:lastBoard';
  const RAIL = '(min-width: 900px)';
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode or full: no copy */ } };

  // This device's push subscription, as ui-sidebar.js sidebar takes it.
  async function deviceState() {
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone ? 'install' : null;
    if (Notification.permission === 'denied') return 'blocked';
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
    } catch { return null; }
  }

  function mount({ here = '', remember = false, data = null } = {}) {
    const aside = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebarScrim');
    // ui.js replaces the BoardUI global when it loads after this, so the renderers are held here.
    const { sidebar, othersWaiting } = globalThis.BoardUI || {};
    if (!aside || !sidebar) return;
    if (remember && here) write(LAST_KEY, here);
    if (!data) { try { data = JSON.parse(read(DATA_KEY) || 'null'); } catch { data = null; } }
    let device = null;
    const rail = matchMedia(RAIL);

    function logoCount() {
      const logo = document.querySelector('.top a.hub');
      if (!logo || !data) return;
      const n = othersWaiting(data, here);
      logo.setAttribute('aria-label', n ? `Boards, ${n} waiting on other boards` : 'Boards');
    }
    // A repaint keeps the drawer's scroll, so a poll doesn't move the list under a finger.
    function paint() {
      if (!data) return;
      const top = aside.scrollTop;
      aside.innerHTML = sidebar(data, { here, device });
      aside.scrollTop = top;
      logoCount();
    }
    async function load() {
      try {
        const r = await fetch('/_hub/sidebar.json', { cache: 'no-store' });
        if (!r.ok) return;
        data = await r.json();
        write(DATA_KEY, JSON.stringify(data));
        paint();
      } catch { /* outside the hub, or the Mac is asleep: keep what shows */ }
    }

    const isOpen = () => aside.classList.contains('open');
    function open() {
      if (rail.matches || isOpen()) return;
      aside.classList.add('open');
      scrim?.classList.add('on');
    }
    function close() {
      if (!isOpen()) return;
      aside.classList.remove('open');
      scrim?.classList.remove('on');
    }
    document.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.target.closest?.('.top a.hub')) { if (!rail.matches) { e.preventDefault(); open(); } return; }
      if (e.target.closest?.('[data-sidebar-close]')) { e.preventDefault(); close(); }
    });
    scrim?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
    rail.addEventListener?.('change', close);
    // A swipe opens from the left edge and closes back toward it; a mostly vertical drag is a scroll.
    let swipe = null;
    addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      swipe = !rail.matches && (isOpen() || t.clientX < 24) ? { x: t.clientX, y: t.clientY, opening: !isOpen() } : null;
    }, { passive: true });
    addEventListener('touchmove', (e) => {
      if (!swipe) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      if (Math.abs(t.clientY - swipe.y) > Math.abs(dx)) { swipe = null; return; }
      if (swipe.opening && dx > 40) { open(); swipe = null; } else if (!swipe.opening && dx < -50) { close(); swipe = null; }
    }, { passive: true });

    paint();
    load();
    deviceState().then((d) => { device = d; paint(); });
    setInterval(() => { if (!document.hidden) load(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    // Coming back to a page from the back-forward cache shows the drawer as it was left.
    addEventListener('pageshow', (e) => { if (e.persisted) close(); });
  }

  globalThis.Sidebar = { mount };
})();
