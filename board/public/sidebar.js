// The sidebar's behaviour on a page with <aside id="sidebar" class="sidebar"> and <div id="sidebarScrim"
// class="sidebar-scrim">, after ui-page-header.js and ui-sidebar.js (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md).
// Sidebar.mount({here, remember, data, poll}) paints `data` or the last copy this device stored, then with poll (the
// default) /_hub/sidebar.json, again every 30 seconds while the page shows. The app shell passes poll false and hands
// each new copy to setData from its one stream (shell.js). The page header's logo (a.hub) toggles the sidebar at every
// width, carrying what waits on the other sites. Below 1000px the sidebar is a drawer: the logo or a swipe in from the
// left edge opens it, and the scrim, Escape, ✕, the drawer's own logo or a swipe back closes it. From 1000px it is a
// rail, which its own logo collapses and the page's logo brings back; this device remembers that, and <html> carries
// sb-collapsed meanwhile (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md). remember stores `here` as
// this device's last board, which `/` opens (shell.js).
// → {setHere(route), setData(data), close(), toggle()}, toggle doing what the logo does
(function () {
  const DATA_KEY = 'hub:sidebar';
  const LAST_KEY = 'hub:lastBoard';
  // app.html and hub/hub.mjs read it before the first paint, so a collapsed rail never shows for a moment.
  const COLLAPSED_KEY = 'hub:sidebarCollapsed';
  const RAIL = '(min-width: 1000px)';
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

  function mount({ here = '', remember = false, data = null, poll = true } = {}) {
    const aside = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebarScrim');
    // ui.js replaces the BoardUI global when it loads after this, so the renderers are held here.
    const { sidebar, othersWaiting } = globalThis.BoardUI || {};
    const none = { setHere() {}, setData() {}, close() {}, toggle() {} };
    if (!aside || !sidebar) return none;
    if (remember && here) write(LAST_KEY, here);
    if (!data) { try { data = JSON.parse(read(DATA_KEY) || 'null'); } catch { data = null; } }
    let device = null;
    const rail = matchMedia(RAIL);
    const html = document.documentElement;
    let collapsed = read(COLLAPSED_KEY) === '1';
    html.classList.toggle('sb-collapsed', collapsed);

    // The sidebar's head is a page header too, so the page's own logo is the one outside it.
    const pageLogo = (el) => (el && !el.closest('.sidebar') ? el : null);
    function logoCount() {
      const logo = [...document.querySelectorAll('.top a.hub')].find(pageLogo);
      if (!logo || !data) return;
      const n = othersWaiting(data, here);
      logo.setAttribute('aria-label', n ? `Boards, ${n} waiting on other boards` : 'Boards');
    }
    // A repaint keeps the drawer's scroll, so a new copy doesn't move the list under a finger.
    function paint() {
      if (!data) return;
      const top = aside.scrollTop;
      aside.innerHTML = sidebar(data, { here, device });
      aside.scrollTop = top;
      logoCount();
    }
    function setData(next) {
      if (!next) return;
      data = next;
      write(DATA_KEY, JSON.stringify(data));
      paint();
    }
    async function load() {
      try {
        const r = await fetch('/_hub/sidebar.json', { cache: 'no-store' });
        if (r.ok) setData(await r.json());
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
    // sb-anim slides the rail only on a tap, so a page that opens collapsed doesn't slide into it.
    let settle = null;
    function collapse(on) {
      collapsed = on;
      write(COLLAPSED_KEY, on ? '1' : '0');
      html.classList.add('sb-anim');
      html.classList.toggle('sb-collapsed', on);
      clearTimeout(settle);
      settle = setTimeout(() => html.classList.remove('sb-anim'), 400);
    }
    function toggle() {
      if (rail.matches) collapse(!collapsed);
      else if (isOpen()) close();
      else open();
    }
    document.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.target.closest?.('[data-sidebar-close]')) { e.preventDefault(); if (rail.matches) collapse(true); else close(); return; }
      if (!pageLogo(e.target.closest?.('.top a.hub'))) return;
      e.preventDefault();
      toggle();
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
    deviceState().then((d) => { device = d; paint(); });
    if (poll) {
      load();
      setInterval(() => { if (!document.hidden) load(); }, 30000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    }
    // Coming back to a page from the back-forward cache shows the drawer as it was left.
    addEventListener('pageshow', (e) => { if (e.persisted) close(); });

    function setHere(route) {
      here = route;
      if (remember && here) write(LAST_KEY, here);
      paint();
    }
    return { setHere, setData, close, toggle };
  }

  globalThis.Sidebar = { mount };
})();
