// The sidebar's behaviour on a page with <aside id="sidebar" class="sidebar"> and <div id="sidebarScrim"
// class="sidebar-scrim">, after ui-page-header.js and ui-sidebar.js (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md).
// Sidebar.mount({here, data}) paints `data` or the last copy this device stored; the app shell hands it each new copy
// through setData from its one stream (shell.js). The page header's logo (a.hub) toggles the sidebar at every
// width, carrying what waits on the other sites. Below 1000px the sidebar is a drawer: the logo or a swipe in from the
// left edge opens it, and the scrim, Escape, ✕, the drawer's own logo or a swipe back closes it. From 1000px it is a
// rail, which its own logo collapses and the page's logo brings back; this device remembers that, and <html> carries
// sb-collapsed meanwhile (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md).
// Switch mode: s pressed twice within a second, outside a text field, a contenteditable or an open dialog, shows each
// row's key (ui-sidebar.js switchKeys), opening the drawer or showing a collapsed rail until it ends; the next key opens
// that row through open(href). Escape, a click, a held modifier, typing in a field or 3 seconds with no key end it
// with nothing opened. A key it uses is defaultPrevented, so the board's other shortcuts skip it.
// mount({here, data, open}): open(href) shows a row's page, by default by loading it.
// → {setHere(route), setData(data), checkDevice(), close(), toggle(), keydown(e), pointerdown()}, toggle doing what the
// logo does, checkDevice reading this device's push subscription again, and keydown and pointerdown taking a framed
// page's events (view-frame.js), as the document's own
(function () {
  const DATA_KEY = 'hub:sidebar';
  // app.html reads it before the first paint, so a collapsed rail never shows for a moment.
  const COLLAPSED_KEY = 'hub:sidebarCollapsed';
  const RAIL = '(min-width: 1000px)';
  const TWICE_MS = 1000;
  // sidebar.css .ks-bar drains over the same time.
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

  function mount({ here = '', data = null, open: openRow = (href) => location.assign(href) } = {}) {
    const aside = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebarScrim');
    // ui.js replaces the BoardUI global when it loads after this, so the renderers are held here.
    const { sidebar, othersWaiting, switchKeys } = globalThis.BoardUI || {};
    const none = { setHere() {}, setData() {}, checkDevice() {}, close() {}, toggle() {}, keydown() {}, pointerdown() {} };
    if (!aside || !sidebar) return none;
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
    // switching: {timer, opened} while switch mode shows, opened when it opened the drawer.
    let switching = null;
    // A repaint keeps the drawer's scroll, so a new copy doesn't move the list under a finger.
    function paint() {
      if (!data) return;
      const top = aside.scrollTop;
      aside.innerHTML = sidebar(data, { here, device, switching: Boolean(switching) });
      aside.scrollTop = top;
      logoCount();
    }
    function setData(next) {
      if (!next) return;
      data = next;
      write(DATA_KEY, JSON.stringify(data));
      paint();
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
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    async function refresh() {
      const response = await fetch('/_hub/sidebar.json');
      if (!response.ok) throw new Error('Could not refresh boards.');
      setData(await response.json());
    }
    function newBoard() {
      if (document.getElementById('newBoardSheet')) return;
      close();
      const sheet = document.createElement('dialog');
      sheet.setAttribute('id', 'newBoardSheet');
      sheet.setAttribute('class', 'sheet');
      sheet.setAttribute('aria-labelledby', 'newBoardTitle');
      sheet.innerHTML = `<form class="nb-form"><div class="sheet-head"><h2 id="newBoardTitle" tabindex="-1" autofocus>New board</h2></div>
        <p class="nb-next">The hub starts a session and joins your board. It usually takes a minute or so. You can keep using your boards.</p>
        <div class="group">
          <label class="nb-field"><span>Name</span><input name="name" type="text" autocomplete="off" placeholder="e.g. Backend audit" required maxlength="60"></label>
          <label class="nb-field"><span>Repo folder</span><select name="folder" required><option value="">Choose a folder…</option>
            ${(data?.repos || []).map((repo) => `<option value="${esc(repo)}">${esc(repo)}</option>`).join('')}<option value="other">Other folder…</option></select>
            <input class="nb-path" name="path" type="text" aria-label="Other repo folder" placeholder="~/dev/another-repo" autocomplete="off" spellcheck="false" hidden disabled></label>
          <label class="nb-field"><span>What it’s for</span><input name="purpose" type="text" placeholder="e.g. Review backend changes" maxlength="240"><span class="nb-help">One line to get the board started.</span></label>
        </div><p class="nb-error" role="alert" hidden></p>
        <div class="nb-actions"><button type="button" data-cancel-new>Cancel</button><button type="submit" class="primary" disabled>Start</button></div></form>`;
      const form = sheet.querySelector('form');
      const field = (name) => form.querySelector(`[name="${name}"]`);
      const start = form.querySelector('[type="submit"]');
      const cancel = form.querySelector('[data-cancel-new]');
      const error = form.querySelector('[role="alert"]');
      let sending = false;
      const folder = () => (field('folder').value === 'other' ? field('path').value : field('folder').value).trim();
      function sync(e) {
        const other = field('folder').value === 'other';
        field('path').hidden = !other;
        field('path').disabled = !other;
        field('path').required = other;
        start.disabled = sending || !field('name').value.trim() || !folder();
        if (e.type === 'change' && e.target === field('folder') && other) field('path').focus();
      }
      const done = () => { if (!sending) sheet.close(); };
      form.addEventListener('input', sync);
      form.addEventListener('change', sync);
      cancel.addEventListener('click', done);
      sheet.addEventListener('cancel', (e) => { e.preventDefault(); done(); });
      sheet.addEventListener('click', (e) => { if (e.target === sheet) done(); });
      sheet.addEventListener('close', () => { stopFitting(); sheet.remove(); aside.querySelector('[data-new-board]')?.focus({ preventScroll: true }); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (sending || start.disabled) return;
        const input = { name: field('name').value.trim(), repo: folder(), purpose: field('purpose').value.trim() };
        sending = true;
        start.disabled = cancel.disabled = true;
        error.hidden = true;
        try {
          const response = await fetch('/_hub/new-board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
          if (!response.ok) throw new Error(await response.text());
          const { route } = await response.json();
          setData({ ...data, starting: [...(data?.starting || []).filter((s) => s.route !== route), { route, title: input.name, askedAt: new Date().toISOString(), failed: false }] });
          sending = false;
          sheet.close();
          if (rail.matches) collapse(false); else open();
          aside.querySelector(`[data-starting="${route}"]`)?.scrollIntoView({ block: 'nearest' });
          refresh().catch(() => {});
        } catch (e) {
          sending = false;
          if (!sheet.isConnected) return;
          error.textContent = e.message || 'Could not start the board. Try again.';
          error.hidden = false;
          cancel.disabled = false;
          sync({});
        }
      });
      document.body.appendChild(sheet);
      const stopFitting = BoardDialogs.fitSheet(sheet);
      sheet.showModal();
    }
    aside.addEventListener('click', async (e) => {
      if (e.target.closest?.('[data-new-board]')) { newBoard(); return; }
      const dismiss = e.target.closest?.('[data-dismiss-board]');
      if (!dismiss || dismiss.disabled) return;
      dismiss.disabled = true;
      try {
        const response = await fetch(`/_hub/new-board/${encodeURIComponent(dismiss.dataset.dismissBoard)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());
        await refresh();
      } catch (e) { dismiss.disabled = false; globalThis.BoardDialogs?.notice(e.message); }
    });
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
      switching = { opened: !rail.matches && !isOpen(), timer: setTimeout(() => endSwitch(), IDLE_MS) };
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
    function keydown(e) {
      if (MODIFIERS.has(e.key) || e.isComposing || e.defaultPrevented) return;
      const mods = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
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
      if (e.key !== 's' && e.key !== 'S') { lastS = -Infinity; return; }
      if (e.repeat) return;
      if (mods || inField(e.target) || dialogOpen(e.target) || !data) { lastS = -Infinity; return; }
      const now = Date.now();
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
    return { setHere, setData, checkDevice, close, toggle, keydown, pointerdown };
  }

  globalThis.Sidebar = { mount };
})();
