// The sidebar's behaviour on a page with <aside id="sidebar" class="sidebar"> and <div id="sidebarScrim"
// class="sidebar-scrim">, after ui-phase-bars.js, ui-page-header.js and ui-sidebar.js (docs/adr/2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md).
// Sidebar.mount({here, data}) paints `data` or the last copy this device stored; the app shell hands it each new copy
// through setData from its one stream (shell.js). The page header's logo (a.hub) toggles the sidebar at every
// width, with what waits on the other sites in its accessible label. Below 900px the sidebar is a drawer: the logo or a swipe in from the
// left edge opens it, and the scrim, Escape, ✕, the drawer's own logo or a swipe back closes it. From 900px it is a
// rail, which its own logo collapses and the page's logo brings back; this device remembers that, and <html> carries
// sb-collapsed meanwhile (docs/adr/2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md).
// Switch mode: s pressed twice within a second, outside a text field, a contenteditable or an open dialog, shows each
// row's key (ui-sidebar.js switchKeys), opening the drawer or showing a collapsed rail until it ends; the next key opens
// that row through open(href). Escape, a click, a held modifier, typing in a field or 3 seconds with no key end it
// with nothing opened. A key it uses is defaultPrevented, so the board's other shortcuts skip it.
// The shortcuts sheet: h pressed twice within a second, on a device with a fine pointer that hovers, under the same
// rules as s, shows or hides ui-sidebar.js shortcuts in a centred sheet over the dimmed page; Escape closes it.
// mount({here, data, open, reload}): open(href) shows a row's page, by default by loading it; reload() reloads the app.
// → {setHere(route), setData(data), setUpdate(state), checkDevice(), close(), toggle(), keydown(e), pointerdown()}, toggle doing what the
// logo does, checkDevice reading this device's push subscription again, and keydown and pointerdown taking a framed
// page's events (view-frame.js), as the document's own
// A starting board's row (docs/adr/2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md): its seconds
// tick in place each second, and a repaint sets its running bar's pulse from the clock, so a new copy never restarts
// it. When the board joins, its row fades in, and a repaint during the fade carries it on from where it was.
(function () {
  const DATA_KEY = 'hub:sidebar';
  // app.html reads it before the first paint, so a collapsed rail never shows for a moment.
  const COLLAPSED_KEY = 'hub:sidebarCollapsed';
  const RAIL = '(min-width: 900px)';
  // A phone has no keys to press, so it never shows the shortcuts sheet.
  const DESKTOP = '(hover: hover) and (pointer: fine)';
  const TWICE_MS = 1000;
  // style.css pulse-fill's period, and sidebar.css sb-join's length.
  const PULSE_MS = 1400;
  const JOIN_MS = 2500;
  // paint() sets the bar's duration from this and its delay from switching.started.
  const IDLE_MS = 3000;
  const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Fn']);
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

  function mount({ here = '', data = null, open: openRow = (href) => location.assign(href), reload = () => {} } = {}) {
    const aside = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebarScrim');
    // ui.js replaces the BoardUI global when it loads after this, so the renderers are held here.
    const { sidebar, failedStart, startCaption, updateRow, othersWaiting, switchKeys, shortcuts } = globalThis.BoardUI || {};
    const none = { setHere() {}, setData() {}, setUpdate() {}, checkDevice() {}, close() {}, toggle() {}, keydown() {}, pointerdown() {} };
    if (!aside || !sidebar) return none;
    if (!data) { try { data = JSON.parse(read(DATA_KEY) || 'null'); } catch { data = null; } }
    let device = null;
    let update = null;
    // While Restart waits for the hub: null | {version} | {version, error}, which replaces the hub's upgrade field in the row.
    let restart = null;
    const upgradeShown = () => (restart ? { state: restart.error ? 'updated' : 'restarting', ...restart } : data?.upgrade);
    let updateHTML = '';
    const rail = matchMedia(RAIL);
    const html = document.documentElement;
    let collapsed = read(COLLAPSED_KEY) === '1';
    html.classList.toggle('sb-collapsed', collapsed);

    // The sidebar's head is a page header too, so the page's own logo is the one outside it.
    const pageLogo = (el) => (el && !el.closest('.sidebar') ? el : null);
    function logoCount() {
      const logo = [...document.querySelectorAll('.top a.hub')].find(pageLogo);
      if (!logo) return;
      const n = othersWaiting(data, here);
      logo.setAttribute('aria-label', `Boards${update ? ', new version ready' : upgradeShown() ? ', update available' : ''}${n ? `, ${n} waiting on other boards` : ''}`);
    }
    // switching: {opened, started, timer} while switch mode shows, opened when it opened the drawer, started on performance.now().
    let switching = null;
    let painted = false;
    // joined: when each board that was starting joined, by route, through its fade. ticker: the seconds' interval while
    // a start runs.
    const joined = new Map();
    let ticker = null;
    const startsRunning = () => (data?.starting || []).filter((s) => !s.failed);
    function tickSteps() {
      for (const s of startsRunning()) {
        const caption = aside.querySelector(`[data-starting="${s.route}"] .sb-step`);
        if (caption) caption.textContent = startCaption(s);
      }
    }
    function paintStarts() {
      const now = Date.now();
      for (const bar of aside.querySelectorAll('.sb-starting .phase-bars i.now')) bar.style.animationDelay = `-${now % PULSE_MS}ms`;
      for (const [route, at] of joined) {
        const row = now - at < JOIN_MS && aside.querySelector(`a.sb-row[href="/${encodeURIComponent(route)}/"]`);
        if (!row) { joined.delete(route); continue; }
        row.classList.add('sb-joined');
        row.style.animationDelay = `-${now - at}ms`;
      }
      const running = startsRunning().length > 0;
      if (running && !ticker) ticker = setInterval(tickSteps, 1000);
      if (!running && ticker) { clearInterval(ticker); ticker = null; }
    }
    // A repaint keeps the drawer's scroll, so a new copy doesn't move the list under a finger.
    function paint() {
      html.classList.toggle('sb-update', Boolean(update || upgradeShown()));
      if (!data) return;
      const scroll = aside.querySelector('.sb-scroll');
      const top = painted ? scroll?.scrollTop : undefined;
      // Screen readers announce a role="status" node only when its own content changes, so the node outlives the repaint.
      const held = aside.querySelector('.sb-update');
      aside.innerHTML = sidebar(data, { here, device, switching: Boolean(switching) });
      if (switching) {
        const bar = aside.querySelector('.ks-bar');
        bar.style.animationDelay = `${switching.started - performance.now()}ms`;
        bar.style.animationDuration = `${IDLE_MS}ms`;
      }
      // A shared person's sidebar has no update row (ui-sidebar.js).
      const fresh = aside.querySelector('.sb-update');
      if (fresh) {
        if (held) fresh.replaceWith(held);
        const row = updateRow(update, upgradeShown());
        if (!held || row !== updateHTML) (held || fresh).innerHTML = row;
        updateHTML = row;
      }
      const list = aside.querySelector('.sb-scroll');
      if (list) list.scrollTop = top ?? list.scrollHeight;
      paintStarts();
      painted = true;
      logoCount();
    }
    function setData(next) {
      if (!next) return;
      const starting = new Set(startsRunning().map((s) => s.route));
      for (const s of next.sites || []) if (starting.has(s.route)) joined.set(s.route, Date.now());
      data = next;
      write(DATA_KEY, JSON.stringify(data));
      paint();
    }
    function setUpdate(state) {
      update = state;
      paint();
    }

    const isOpen = () => aside.classList.contains('open');
    function open() {
      if (rail.matches || isOpen()) return;
      aside.classList.add('open');
      const list = aside.querySelector('.sb-scroll');
      if (list) list.scrollTop = list.scrollHeight;
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
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    async function refresh() {
      const response = await fetch('/_hub/sidebar.json');
      if (!response.ok) throw new Error('Could not refresh boards.');
      setData(await response.json());
    }
    function newBoard() {
      close();
      BoardDialogs.repoSheet({
        async save(input, selected) {
          const response = await fetch('/_hub/new-board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
          if (!response.ok) throw new Error(await response.text());
          const { route } = await response.json();
          setData({ ...data, starting: [...(data?.starting || []).filter((s) => s.route !== route), { route, title: input.name, repo: selected.clone, step: selected.cloned ? 'starting' : 'cloning', stepAt: new Date().toISOString(), askedAt: new Date().toISOString(), failed: false }] });
          if (rail.matches) collapse(false); else open();
          aside.querySelector(`[data-starting="${route}"]`)?.scrollIntoView({ block: 'nearest' });
          refresh().catch(() => {});
        },
        onClose: () => aside.querySelector('[data-new-board]')?.focus({ preventScroll: true }),
      });
    }
    aside.addEventListener('click', (e) => {
      const refreshApp = e.target.closest?.('[data-app-reload]');
      if (refreshApp) {
        if (!refreshApp.disabled && update !== 'reloading') { setUpdate('reloading'); reload(); }
        return;
      }
      const restartApp = e.target.closest?.('[data-app-restart]');
      if (restartApp) { if (!restartApp.disabled) restartHub(); return; }
      const upgradeApp = e.target.closest?.('[data-app-upgrade]');
      if (upgradeApp) { if (!upgradeApp.disabled) upgrade(upgradeApp); return; }
      if (e.target.closest?.('[data-new-board]')) { newBoard(); return; }
      const failed = e.target.closest?.('[data-failed-start]');
      if (failed) openFailed(failed.dataset.failedStart);
    });
    // Restart asks the hub to restart (POST /_hub/restart-hub), then polls until it answers with other code than it ran (its
    // x-hub-code) and reloads the page (docs/adr/2026-11-05-2200-the-hub-pulls-a-new-version-itself-and-offers-restart.md).
    // Past RESTART_TRIES polls the row goes back to Restart with how to restart by hand.
    const RESTART_TRIES = 120;
    async function restartHub() {
      if (restart) return;
      const version = data.upgrade.version;
      restart = { version };
      paint();
      let before, command;
      try {
        const response = await fetch('/_hub/restart-hub', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'The hub didn’t restart.');
        before = response.headers.get('x-hub-code');
        command = body.command;
      } catch (e) {
        restart = { version, error: e.message || 'The hub didn’t answer.' };
        paint();
        restart = null;
        return;
      }
      for (let i = 0; i < RESTART_TRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const response = await fetch('/_hub/api/hub', { cache: 'no-store', headers: { accept: 'application/json' } });
          const code = response.headers.get('x-hub-code');
          if (response.ok && code && code !== before) { reload(); return; }
        } catch { /* the hub is down while it restarts */ }
      }
      restart = { version, error: `The hub hasn’t come back. On the host, run ${command}` };
      paint();
      restart = null;
    }
    // Update pulls again after a failed pull (docs/adr/2026-11-05-2200-the-hub-pulls-a-new-version-itself-and-offers-restart.md). The row
    // waits (ui.js waitOn) until the hub answers with what it did, then while that pull runs (ui-sidebar.js
    // updateRow), and a refusal shows as a failed update.
    function upgrade(button) {
      BoardUI.waitOn(button, (async () => {
        let next;
        try {
          const response = await fetch('/_hub/upgrade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const body = await response.json().catch(() => ({}));
          next = response.ok ? body.upgrade : { ...data.upgrade, state: 'failed', error: body.error || 'The hub didn’t answer.' };
        } catch {
          next = { ...data.upgrade, state: 'failed', error: 'The hub didn’t answer.' };
        }
        setData({ ...data, upgrade: next });
      })());
    }
    // A failed start's sheet (docs/adr/2026-11-02-2006-a-failed-start-retries-from-its-sheet.md). Dismiss deletes its Starting
    // record; Retry starts it again, and its row reads starting… until the hub's next copy says otherwise.
    function openFailed(route) {
      const s = (data?.starting || []).find((x) => x.route === route && x.failed);
      if (!s || document.getElementById('failedStartSheet')) return;
      const previous = document.activeElement;
      const el = document.createElement('dialog');
      el.setAttribute('id', 'failedStartSheet');
      el.setAttribute('class', 'sheet');
      el.setAttribute('aria-labelledby', 'failedStartTitle');
      el.innerHTML = failedStart(s, { home: data.home });
      let sending = false;
      const done = () => { if (!sending) el.close(); };
      // The tapped button waits (ui.js waitOn), the other disabled, until the hub answers.
      async function act(button, request, after) {
        sending = true;
        const refused = el.querySelector('.fs-refused');
        refused.hidden = true;
        try {
          const response = await BoardUI.waitOn(button, fetch(`/_hub/new-board/${encodeURIComponent(route)}${request.path || ''}`, request.options), { group: el.querySelectorAll('.fs-actions button') });
          if (!response.ok) throw new Error(await response.text());
          after();
          sending = false;
          el.close();
          refresh().catch(() => {});
        } catch (e) {
          sending = false;
          refused.textContent = e.message;
          refused.hidden = false;
        }
      }
      el.addEventListener('click', (e) => {
        if (sending) return;
        if (e.target === el || e.target.closest('[data-failed-close]')) { done(); return; }
        const dismiss = e.target.closest('[data-failed-dismiss]');
        const retry = e.target.closest('[data-failed-retry]');
        if (dismiss) {
          act(dismiss, { options: { method: 'DELETE' } }, () => setData({ ...data, starting: data.starting.filter((x) => x.route !== route) }));
        } else if (retry) {
          act(retry, { path: '/retry', options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } }, () => {
            const { error, ...rest } = s;
            const again = { ...rest, step: 'starting', stepAt: new Date().toISOString(), askedAt: new Date().toISOString(), failed: false };
            setData({ ...data, starting: data.starting.map((x) => (x.route === route ? again : x)) });
          });
        }
      });
      el.addEventListener('cancel', (e) => { e.preventDefault(); done(); });
      el.addEventListener('close', () => {
        el.remove();
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      });
      document.body.appendChild(el);
      el.showModal();
      (el.querySelector('[data-failed-retry]') || el.querySelector('[data-failed-dismiss]')).focus({ preventScroll: true });
    }
    document.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.target.closest?.('[data-sidebar-close]')) { e.preventDefault(); if (rail.matches) collapse(true); else close(); return; }
      if (!pageLogo(e.target.closest?.('.top a.hub'))) return;
      e.preventDefault();
      toggle();
    });
    scrim?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && isOpen()) close(); });

    let lastS = -Infinity;
    function startSwitch() {
      lastS = -Infinity;
      switching = { opened: !rail.matches && !isOpen(), started: performance.now(), timer: setTimeout(() => endSwitch(), IDLE_MS) };
      if (switching.opened) open();
      aside.classList.add('ks-on');
      paint();
    }
    function endSwitch({ keepDrawer = false } = {}) {
      if (!switching) return;
      clearTimeout(switching.timer);
      const { opened } = switching;
      switching = null;
      // No repaint here: a click that ended it must land on the row it pressed, so the keys only hide (sidebar.css).
      aside.classList.remove('ks-on');
      if (opened && !keepDrawer) close();
    }
    // A framed page's event comes from another window, so its target is checked by duck type, not instanceof.
    const inField = (t) => Boolean(t?.closest?.(FIELD));
    const dialogOpen = (t) => Boolean(document.querySelector('dialog[open]') || t?.ownerDocument?.querySelector?.('dialog[open]'));

    // help: {el, previous} while the shortcuts sheet shows, previous holding the focus to give back.
    let help = null;
    let lastH = -Infinity;
    function closeHelp() {
      if (!help) return;
      const { el, previous } = help;
      help = null;
      if (el.open) el.close();
      el.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    }
    function toggleHelp() {
      if (help) { closeHelp(); return; }
      const el = document.createElement('dialog');
      el.setAttribute('id', 'shortcutsSheet');
      el.setAttribute('class', 'sheet shortcuts-sheet');
      el.setAttribute('aria-labelledby', 'shortcutsTitle');
      el.innerHTML = shortcuts();
      el.addEventListener('cancel', (e) => { e.preventDefault(); closeHelp(); });
      el.addEventListener('close', closeHelp);
      el.addEventListener('click', (e) => { if (e.target === el) closeHelp(); });
      help = { el, previous: document.activeElement };
      document.body.appendChild(el);
      el.showModal();
    }

    function keydown(e) {
      if (MODIFIERS.has(e.key) || e.isComposing || e.defaultPrevented) return;
      const mods = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
      if (help && e.key === 'Escape') { e.preventDefault(); closeHelp(); return; }
      if (switching) {
        if (e.key === 'Escape') { e.preventDefault(); endSwitch(); return; }
        if (mods || inField(e.target)) { endSwitch(); return; }
        e.preventDefault();
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const row = switchKeys(data).find((k) => k.num === key || k.letter === key);
        endSwitch({ keepDrawer: Boolean(row) });
        if (row) openRow(row.href);
        return;
      }
      const key = e.key.toLowerCase();
      if (key !== 's') lastS = -Infinity;
      if (key !== 'h') lastH = -Infinity;
      if ((key !== 's' && key !== 'h') || e.repeat) return;
      if (mods || inField(e.target)) { lastS = lastH = -Infinity; return; }
      const now = Date.now();
      if (key === 'h') {
        if (!matchMedia(DESKTOP).matches || (!help && dialogOpen(e.target))) { lastH = -Infinity; return; }
        if (now - lastH <= TWICE_MS) { lastH = -Infinity; e.preventDefault(); toggleHelp(); return; }
        lastH = now;
        return;
      }
      if (dialogOpen(e.target) || !data) { lastS = -Infinity; return; }
      if (now - lastS <= TWICE_MS) { e.preventDefault(); startSwitch(); return; }
      lastS = now;
    }
    function pointerdown() { endSwitch({ keepDrawer: true }); }
    // Capturing, so switch mode sees a key before any view's own shortcut does.
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointerdown, true);
    rail.addEventListener?.('change', () => { endSwitch(); close(); });
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

    const checkDevice = () => deviceState().then((d) => { device = d; paint(); });
    paint();
    checkDevice();
    // Coming back to a page from the back-forward cache shows the drawer as it was left.
    addEventListener('pageshow', (e) => { if (e.persisted) close(); });

    function setHere(route) {
      here = route;
      paint();
    }
    return { setHere, setData, setUpdate, checkDevice, close, toggle, keydown, pointerdown };
  }

  globalThis.Sidebar = { mount };
})();
