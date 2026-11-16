// What the hub page and settings modals share, Board Settings' duration picker included, each through the view's B
// (app.js BoardView.page), so unmounting the view stops it all: loading and refreshing the view's data, posting its
// forms for JSON, and this device's notifications row.
(function () {
  const age = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'now' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };

  // Paints url()'s JSON with paint(data) now and every `every` ms while the view shows, as the header's time says; a
  // refresh waits while busy() or the page is hidden, and the time then says how old the data is. The header's refresh
  // button loads at once. paint(null) means the first load failed. linked(online) hears whether each load reached the
  // host. → load()
  function live(B, { url, paint, busy = () => false, every = 30000, linked = () => {} }) {
    const refresh = B.$('#refresh');
    const status = B.$('#status');
    let at = 0;
    let loaded = false;
    async function load() {
      if (refresh) refresh.disabled = true;
      refresh?.classList.add('spinning');
      try {
        const r = await fetch(url(), { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        if (!B.alive()) return;
        at = Date.now();
        globalThis.AppShell?.codeSeen?.(r.headers?.get('x-hub-code'));
        paint(data);
        linked(true);
        if (status) status.textContent = 'now';
      } catch {
        if (!B.alive()) return;
        linked(false);
        if (!loaded) paint(null);
        if (status) status.innerHTML = BoardUI.statusLine(undefined, { link: 'offline' });
      }
      loaded = true;
      if (refresh) refresh.disabled = false;
      refresh?.classList.remove('spinning');
      const gear = B.$('#settingsLink');
      gear?.removeAttribute('aria-disabled');
      gear?.removeAttribute('tabindex');
    }
    B.on(refresh, 'click', load);
    const tick = () => {
      if (document.hidden || busy()) { if (at && status) status.textContent = age(Date.now() - at); return; }
      load();
    };
    B.every(every, tick);
    B.on(document, 'visibilitychange', () => { if (!document.hidden && Date.now() - at >= every) tick(); });
    load();
    return load;
  }

  const FAILED = 'Could not save. Is the host awake?';
  // Every form in the view that posts to /_hub/ posts for JSON in place of loading a page: answer(body, action) takes
  // the hub's answer, fail(message) a refusal. A checkbox marked data-submit saves on change, and a time input marked
  // data-autosave once its picker closes, so turning an iOS wheel doesn't save each value it passes. accepts(action, form)
  // limits it to some of those forms, since the Hub page and its hub settings each wire their own over one root.
  // While a post is out its control waits (ui.js waitOn): the tapped button, or else the form's toggle or field, with
  // the form's other buttons, the setting's other choices, disabled.
  // → {busy()}, true while a post is out
  function forms(B, { answer, fail, accepts = () => true }) {
    let sending = false;
    B.on(B.root, 'submit', async (e) => {
      if (e.defaultPrevented) return;
      const form = e.target;
      const action = form.getAttribute?.('action') || '';
      if (!action.startsWith('/_hub/') || !accepts(action, form)) return;
      e.preventDefault();
      if (sending) return;
      const body = new URLSearchParams(new FormData(form));
      if (e.submitter?.name) body.append(e.submitter.name, e.submitter.value);
      sending = true;
      const post = fetch(action, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body })
        .then(async (r) => [r, await r.json().catch(() => null)]);
      try {
        const [r, out] = await BoardUI.waitOn(e.submitter || form.querySelector('input:not([type="hidden"]), select'), post, { group: form.querySelectorAll('button') });
        if (!B.alive()) return;
        if (r.ok && out) answer(out, action); else fail(out?.error || FAILED);
      } catch {
        if (B.alive()) fail(FAILED);
      } finally { sending = false; }
    });
    const save = (el) => { if (el.value && el.value !== el.defaultValue && el.checkValidity()) el.form.requestSubmit(); };
    B.on(B.root, 'change', (e) => {
      const el = e.target;
      if (el.form && !accepts(el.form.getAttribute('action') || '', el.form)) return;
      if (el.matches?.('input[data-submit]')) el.form.requestSubmit();
      else if (el.matches?.('input[data-autosave]') && document.activeElement !== el) save(el);
    });
    B.on(B.root, 'focusout', (e) => {
      const el = e.target;
      if (el.matches?.('input[data-autosave]') && accepts(el.form?.getAttribute('action') || '', el.form)) save(el);
    });
    return { busy: () => sending };
  }

  // This device's push subscription, as HubUI.deviceRow shows it: Turn on subscribes, Test sends a test push, and each
  // showing of the row tells the hub of a subscription this device no longer has.
  // iOS allows web push only in a Home Screen app, and asks for permission only from a tap, so requestPermission runs
  // first in the tap. paint() redraws the row, never before device() returns; changed() follows a subscription this
  // device just made.
  // → {state() for HubUI.deviceRow with the hub's line for an `on` device, busy(), ready: a promise settled once the
  // row first shows}
  function device(B, { paint, changed = () => {} }) {
    let state = null;
    let on = false;
    let busy = false;
    const standalone = navigator.standalone || globalThis.matchMedia?.('(display-mode: standalone)').matches;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
    const keyBytes = (k) => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
    const show = (next, isOn = false) => { if (!B.alive()) return; state = next; on = isOn; paint(); };
    // The endpoint this device last gave the hub, kept in this browser, so that once the subscription goes (the
    // browser dropped or replaced it, or notifications were blocked) the page tells the hub to forget it
    // (docs/adr/2026-11-03-0501-the-hub-reads-healthy-degraded-or-a-site-down.md).
    const KEPT = 'kickflip.push.endpoint';
    const kept = () => { try { return localStorage.getItem(KEPT); } catch { return null; } };
    const keep = (endpoint) => { try { if (endpoint) localStorage.setItem(KEPT, endpoint); else localStorage.removeItem(KEPT); } catch { /* storage blocked here */ } };
    // The id the hub gave that subscription, so the Integrations list marks this device's line (view-hub.js).
    const subscribe = (sub) => post('/_hub/push/subscribe', sub.toJSON()).then(({ id }) => { try { localStorage.setItem('kickflip.push.id', id); } catch { /* storage blocked here */ } });
    const settle = (endpoint = null) => {
      const old = kept();
      if (old && old !== endpoint) post('/_hub/push/unsubscribe', { endpoint: old }).catch(() => {});
      keep(endpoint);
    };

    async function render() {
      if (!('serviceWorker' in navigator) || !('PushManager' in globalThis)) {
        if (ios && !standalone) show({ title: 'Add to Home Screen', sub: 'Tap Share, then Add to Home Screen, and open Claude from your Home Screen to turn on notifications.' });
        return;
      }
      if (Notification.permission === 'denied') {
        settle();
        show({ title: 'Notifications are blocked', sub: `Allow them in ${ios ? 'Settings → Notifications → Claude.' : "this browser's site settings."}` });
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      settle(sub?.toJSON().endpoint);
      if (sub) {
        subscribe(sub).catch(() => {});
        show({ title: 'This device', action: { label: 'Test', act: 'test', quiet: true } }, true);
      } else {
        show({ title: 'This device', sub: 'Off · Claude sessions tell you here when something needs you.', action: { label: 'Turn on', act: 'on' } });
      }
    }
    async function enable() {
      busy = true;
      show({ ...state, action: { ...state.action, busy: true } }, on);
      try {
        if (await Notification.requestPermission() !== 'granted') { await render(); return; }
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const { key } = await (await fetch('/_hub/push/key')).json();
        const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
        await subscribe(sub);
        await render();
        changed();
      } catch (err) { show({ title: 'Could not turn on notifications', sub: String(err?.message || err) }); }
      finally { busy = false; }
    }
    async function test() {
      show({ ...state, action: { ...state.action, busy: true } }, true);
      const r = await post('/_hub/push/test').catch(() => null);
      show({ ...state, action: { ...state.action, busy: false, label: r?.sent ? 'Sent' : 'Could not send' } }, true);
    }
    B.on(B.root, 'click', (e) => {
      const act = e.target.closest?.('[data-device]')?.dataset.device;
      if (act === 'on') enable(); else if (act === 'test') test();
    });
    const ready = Promise.resolve().then(render).catch(() => {});
    return { state: (line) => (state && on ? { ...state, sub: `On · ${line}` } : state), busy: () => busy, ready };
  }

  // datetime-local speaks the device's clock; the picker's hidden field carries its UTC ISO value to the server.
  const localInput = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  function customBounds(input, reset = false) {
    const now = Date.now();
    input.min = localInput(new Date(now + 60_000));
    input.max = localInput(new Date(now + 30 * 86_400_000));
    if (reset) input.value = input.defaultValue = localInput(new Date(now + 3_600_000));
  }

  // The one duration picker Snooze, Pause hub and Pause board share (hub/duration.mjs): chips that post
  // `name` to `action` at once, then Custom, whose date and time posts as `name` too. While its setting is on, `on`
  // replaces it with when it ends and a button that posts `name`=off.
  function durationPicker({ id, title, icon, action, name, choices, on, button }) {
    const { esc } = HubUI;
    if (on) return `<div class="row dur-on">${icon}<span class="body"><span class="text title">${esc(on.title)}</span><form method="post" action="${action}"><button class="btn quiet" name="${name}" value="off">${button}</button></form></span></div>`;
    if (!choices) return '';
    const chips = choices.map((c) => `<button class="btn quiet" name="${name}" value="${esc(c.value)}" aria-label="${esc(`${c.label}, ${c.until}`)}">${esc(c.label)}</button>`).join('');
    return `<div class="block" role="group" aria-labelledby="${id}Title"><div class="dur-head">${icon}<span class="title" id="${id}Title">${title}</span></div><div class="dur-chips"><form class="dur-choices" method="post" action="${action}">${chips}</form><form class="dur-custom" method="post" action="${action}"><input type="hidden" name="${name}"><span class="btn quiet" aria-hidden="true">Custom</span><input type="datetime-local" data-dur-at required aria-label="Custom ${title.toLowerCase()} until a date and time"></form></div></div>`;
  }

  // Wires every duration picker under B.root: Custom opens its picker, and closing it submits its form with the time
  // chosen. → painted(), which a view calls after drawing a picker to set Custom's bounds and suggested time.
  function durationPickers(B) {
    let openPicker = null;
    B.on(B.root, 'click', (e) => {
      const input = e.target.closest?.('[data-dur-at]');
      if (!input) return;
      openPicker = input;
      customBounds(input, input.value === input.defaultValue);
      try { input.showPicker(); } catch { /* iOS opens its wheel on the tap itself. */ }
    });
    // A chip's pointerdown comes before Custom's focusout; without this reset Custom posts first and the chip's post is dropped.
    B.on(B.root, 'pointerdown', (e) => {
      const input = e.target.closest?.('.dur-choices button') && e.target.closest('.dur-chips')?.querySelector('[data-dur-at]');
      if (!input) return;
      openPicker = null;
      input.value = input.defaultValue;
    });
    // Closing an opened picker accepts its suggested time; an unchanged field reached by Tab does nothing.
    const saveCustom = (input) => {
      if (!input.value || (input !== openPicker && input.value === input.defaultValue) || !input.checkValidity()) return;
      const at = new Date(input.value);
      if (Number.isNaN(at.getTime())) return;
      input.form.querySelector('input[type="hidden"]').value = at.toISOString();
      input.form.requestSubmit();
      openPicker = null;
      input.defaultValue = input.value;
    };
    B.on(B.root, 'change', (e) => {
      if (e.target.matches?.('[data-dur-at]') && document.activeElement !== e.target) saveCustom(e.target);
    });
    B.on(B.root, 'focusout', (e) => {
      if (e.target.matches?.('[data-dur-at]')) saveCustom(e.target);
    });
    return { painted: () => { for (const input of B.root.querySelectorAll('[data-dur-at]')) customBounds(input, true); } };
  }

  globalThis.HubKit = { live, forms, device, durationPicker, durationPickers };
})();
