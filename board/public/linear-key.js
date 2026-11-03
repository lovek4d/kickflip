// Hub's Linear key slot. Hub settings › Linear mounts it, and the Tickets control (dialogs.js) opens it over Board
// settings or New board when Linear is tapped without a working key
// (docs/adr/0117-a-board-picks-linear-only-while-hubs-key-works.md). A key saves on paste, change or Enter through
// POST /_hub/settings/linear, which checks it with Linear; linear is hub/views.mjs settingsView's `linear`.
(function () {
  const FAILED = 'Could not save. Is the host awake?';
  const SPIN = '<span class="try-spin" aria-hidden="true"></span>';
  const works = (linear) => Boolean(linear?.set && !linear.refused);

  function slot(linear, { checking, flash }) {
    const { esc, row, tile } = HubUI;
    const sub = checking ? `<span class="lk-checking">${SPIN}Checking the key with Linear…</span>`
      : `${linear.down ? `<span class="st down">${esc(linear.down)}</span> · ` : ''}${linear.keys
        ? esc(linear.sub).replace(esc(linear.keys.label), `<a href="${esc(linear.keys.url)}" target="_blank" rel="noopener">${esc(linear.keys.label)}</a>`)
        : esc(linear.sub)}`;
    const remove = linear.set && !checking ? '<button type="button" class="btn quiet danger" data-linear-remove>Remove</button>' : '';
    const placeholder = checking ? 'Checking…' : linear.set ? 'Paste a new key to replace it' : 'Paste a Linear API key';
    return `${HubUI.flash(flash)}<div class="group">${row({ icon: tile('key', linear.refused ? 'var(--color-danger)' : 'var(--color-quiet)'), title: esc(linear.title), sub, wrap: !works(linear), trail: remove })}`
      + `<form class="block lk-form"><input id="linearKey" name="key" type="password" required${checking ? ' disabled' : ''} placeholder="${placeholder}" aria-label="Linear API key" autocomplete="off" autocapitalize="off" spellcheck="false"></form></div>`
      + '<p class="note">Stays on the host. Boards use it to list teams and projects, create issues and move the ones that are yours. A board can pick Linear for its tickets only while this key works.</p>';
  }

  // Draws the slot into root and saves from it. busy(true) starts each save and busy(false) ends it; saved(out) gets
  // each answer, /_hub/api/settings's JSON, before the slot repaints; worked() follows a saved key Linear accepted.
  // → {busy(), settled(): a promise that resolves once no save is out, linear(), set(linear) unless busy, destroy()}
  function mount(root, { linear, saved = () => {}, worked = () => {}, busy = () => {} }) {
    let current = linear, flash = null, checking = false, pending = null, destroyed = false;
    const paint = () => {
      const typed = root.querySelector('#linearKey')?.value || '';
      root.innerHTML = slot(current, { checking, flash });
      if (!checking) root.querySelector('#linearKey').value = typed;
    };
    function post(body) {
      checking = body.has('key');
      flash = null;
      pending = (async () => {
        try {
          const r = await fetch('/_hub/settings/linear', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
          const out = await r.json().catch(() => null);
          if (destroyed) return;
          if (r.ok && out) { current = out.linear; saved(out); } else flash = { text: out?.error || FAILED, error: true };
        } catch { flash = { text: FAILED, error: true }; }
        const key = checking;
        checking = false;
        pending = null;
        if (destroyed) return;
        busy(false);
        paint();
        if (key && works(current)) worked();
      })();
      busy(true);
      paint();
      return pending;
    }
    const save = (value) => { if (!pending && value.trim()) post(new URLSearchParams({ key: value.trim() })); };
    const onPaste = (e) => {
      const text = e.clipboardData?.getData('text');
      if (!e.target.matches?.('#linearKey') || !text) return;
      e.preventDefault();
      e.target.value = text.trim();
      save(e.target.value);
    };
    const onChange = (e) => { if (e.target.matches?.('#linearKey')) save(e.target.value); };
    const onSubmit = (e) => {
      if (!e.target.matches?.('.lk-form')) return;
      e.preventDefault();
      save(e.target.querySelector('#linearKey').value);
    };
    const onClick = async (e) => {
      if (!e.target.closest?.('[data-linear-remove]') || pending) return;
      if (await BoardDialogs.confirm('Boards on Linear can’t create issues or move tickets until you add a key again. Remove the Linear key?') && !destroyed) post(new URLSearchParams({ remove: '1' }));
    };
    const listeners = [['paste', onPaste], ['change', onChange], ['submit', onSubmit], ['click', onClick]];
    for (const [type, fn] of listeners) root.addEventListener(type, fn);
    paint();
    return {
      busy: () => Boolean(pending),
      settled: () => pending || Promise.resolve(),
      linear: () => current,
      set(next) { if (!pending) { current = next; paint(); } },
      destroy() { destroyed = true; for (const [type, fn] of listeners) root.removeEventListener(type, fn); },
    };
  }

  // Done's spinner while a save is out (style.css .settings-footer [aria-busy]).
  function doneBusy(buttons, busy) {
    for (const b of buttons) {
      if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      if (b.closest('.settings-footer')) b.innerHTML = `${busy ? SPIN : ''}Done`;
    }
  }

  // The slot in a modal of its own over the page. It closes itself once a pasted key works; Done, ✕, Escape and the
  // backdrop close it once no save is out. → a promise of whether the key works on closing
  function open() {
    const previous = document.activeElement;
    const wrap = document.createElement('div');
    // hub.css styles the slot under .hub-view main; style.css draws both as display: contents.
    wrap.setAttribute('class', 'hub-view lk-over');
    wrap.innerHTML = '<main><dialog class="settings-modal hub-modal" id="linearKeyModal" aria-labelledby="linearKeyTitle"><div class="settings-head"><div><h2 id="linearKeyTitle" tabindex="-1">Linear</h2><p class="muted small">Hub settings</p></div><button type="button" class="ghost" data-lk-done aria-label="Close Linear key">✕</button></div>'
      + '<div class="set settings-body"><div class="setting-content"><p class="note">Loading…</p></div></div><div class="settings-footer"><button type="button" data-lk-done>Done</button></div></dialog></main>';
    document.body.appendChild(wrap);
    const dialog = wrap.querySelector('dialog');
    const content = wrap.querySelector('.setting-content');
    const unfit = BoardDialogs.fitSheet(dialog);
    let key = null, closing = false, finished = false, resolve;
    const result = new Promise((r) => { resolve = r; });
    function finish() {
      if (finished) return;
      finished = true;
      key?.destroy();
      unfit();
      dialog.close();
      wrap.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(works(key?.linear()));
    }
    function close() {
      if (!key?.busy()) { finish(); return; }
      if (closing) return;
      closing = true;
      key.settled().then(finish);
    }
    dialog.addEventListener('click', (e) => {
      if (e.target.closest?.('[data-lk-done]')) { close(); return; }
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    dialog.showModal();
    wrap.querySelector('#linearKeyTitle').focus({ preventScroll: true });
    fetch('/_hub/api/settings', { cache: 'no-store', headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : Promise.reject())).then((out) => {
      if (finished) return;
      key = mount(content, { linear: out.linear, worked: finish, busy: (on) => doneBusy(wrap.querySelectorAll('[data-lk-done]'), on) });
    }).catch(() => { if (!finished) content.innerHTML = '<p class="note">Offline. Is the host awake?</p>'; });
    return result;
  }

  globalThis.LinearKey = { works, mount, open, doneBusy };
})();
