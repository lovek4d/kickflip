// Hub's token slots: Linear's key and Slack's user token. The Hub settings modals for Linear and Slack mount them, and the Tickets
// control (dialogs.js) opens Linear's over Board settings or New board when Linear is tapped without a working key
// (docs/adr/2026-11-02-1712-a-board-picks-linear-only-while-hubs-key-works.md). A token saves on paste, change or Enter
// through POST /_hub/settings/<kind>, which checks it with the service; state is hub/views.mjs settingsView's `<kind>`.
(function () {
  const FAILED = 'Could not save. Is the host awake?';
  const SPIN = '<span class="try-spin" aria-hidden="true"></span>';
  const works = (state) => Boolean(state?.set && !state.refused);
  const KINDS = {
    linear: { field: 'key', input: 'linearKey', checking: 'Checking the key with Linear…', first: 'Paste a Linear API key', replace: 'Paste a new key to replace it', label: 'Linear API key',
      note: 'Stays on the host. Boards use it to list teams and projects, create issues and move the ones that are yours. A board can pick Linear for its tickets only while this key works.',
      confirm: 'Boards on Linear fall back to internal tickets, and their tasks keep the Linear tickets they have. Remove the Linear key?' },
    slack: { field: 'token', input: 'slackToken', checking: 'Checking the token with Slack…', first: 'Paste a Slack user token', replace: 'Paste a new token to replace it', label: 'Slack user token',
      note: 'Stays on the host. The hub sends your reviewers their PR links, git_merged reactions and weekday digests as you, in your DMs with them.',
      confirm: 'Reviewer links, reactions and digests stop until a token is back. Remove the Slack token?' },
  };

  function slot(kind, state, { checking, flash }) {
    const { esc, row, tile } = HubUI;
    const k = KINDS[kind];
    const sub = checking ? `<span class="lk-checking">${SPIN}${k.checking}</span>`
      : `${state.down ? `<span class="st down">${esc(state.down)}</span> · ` : ''}${state.keys
        ? esc(state.sub).replace(esc(state.keys.label), `<a href="${esc(state.keys.url)}" target="_blank" rel="noopener">${esc(state.keys.label)}</a>`)
        : esc(state.sub)}`;
    const remove = state.set && !checking ? `<button type="button" class="btn quiet danger" data-${kind}-remove>Remove</button>` : '';
    const placeholder = checking ? 'Checking…' : state.set ? k.replace : k.first;
    return `${HubUI.flash(flash)}<div class="group">${row({ icon: tile('key', state.refused ? 'var(--color-danger)' : 'var(--color-quiet)'), title: esc(state.title), sub, wrap: !works(state), trail: remove })}`
      + `<form class="block lk-form"><input id="${k.input}" name="${k.field}" type="password" required${checking ? ' disabled' : ''} placeholder="${placeholder}" aria-label="${k.label}" autocomplete="off" autocapitalize="off" spellcheck="false"></form></div>`
      + `<p class="note">${k.note}</p>`;
  }

  // Draws kind's slot into root and saves from it. busy(true) starts each save and busy(false) ends it; saved(out) gets
  // each answer, /_hub/api/settings's JSON, before the slot repaints; worked() follows a saved token the service accepted.
  // → {busy(), settled(): a promise that resolves once no save is out, state(), set(state) unless busy, destroy()}
  function mount(root, { kind = 'linear', state, saved = () => {}, worked = () => {}, busy = () => {} }) {
    const k = KINDS[kind];
    const input = `#${k.input}`;
    let current = state, flash = null, checking = false, pending = null, destroyed = false;
    const paint = () => {
      const typed = root.querySelector(input)?.value || '';
      root.innerHTML = slot(kind, current, { checking, flash });
      if (!checking) root.querySelector(input).value = typed;
    };
    function post(body) {
      checking = body.has(k.field);
      flash = null;
      pending = (async () => {
        try {
          const r = await fetch(`/_hub/settings/${kind}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
          const out = await r.json().catch(() => null);
          if (destroyed) return;
          if (r.ok && out) { current = out[kind]; saved(out); } else flash = { text: out?.error || FAILED, error: true };
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
    const save = (value) => { if (!pending && value.trim()) post(new URLSearchParams({ [k.field]: value.trim() })); };
    const onPaste = (e) => {
      const text = e.clipboardData?.getData('text');
      if (!e.target.matches?.(input) || !text) return;
      e.preventDefault();
      e.target.value = text.trim();
      save(e.target.value);
    };
    const onChange = (e) => { if (e.target.matches?.(input)) save(e.target.value); };
    const onSubmit = (e) => {
      if (!e.target.matches?.('.lk-form')) return;
      e.preventDefault();
      save(e.target.querySelector(input).value);
    };
    const onClick = async (e) => {
      if (!e.target.closest?.(`[data-${kind}-remove]`) || pending) return;
      if (await BoardDialogs.confirm(k.confirm) && !destroyed) post(new URLSearchParams({ remove: '1' }));
    };
    const listeners = [['paste', onPaste], ['change', onChange], ['submit', onSubmit], ['click', onClick]];
    for (const [type, fn] of listeners) root.addEventListener(type, fn);
    paint();
    return {
      busy: () => Boolean(pending),
      settled: () => pending || Promise.resolve(),
      state: () => current,
      set(next) { if (!pending) { current = next; paint(); } },
      destroy() { destroyed = true; for (const [type, fn] of listeners) root.removeEventListener(type, fn); },
    };
  }

  // The footer's Done waits, disabled with a spinner in place of its word (style.css button[aria-busy="true"]), while a
  // save is out; ✕, Escape and the backdrop close once it lands.
  function doneBusy(buttons, busy) {
    for (const b of buttons) {
      if (!b.closest('.settings-footer')) continue;
      b.disabled = busy;
      if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
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
      resolve(works(key?.state()));
    }
    function close() {
      if (!key?.busy()) { finish(); return; }
      if (closing) return;
      closing = true;
      key.settled().then(finish);
    }
    dialog.addEventListener('click', (e) => {
      if (e.target.closest?.('[data-lk-done]')) { close(); return; }
      if (!BoardUI.onBackdrop(e, dialog)) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    BoardUI.swipeToDismiss(dialog);
    dialog.showModal();
    wrap.querySelector('#linearKeyTitle').focus({ preventScroll: true });
    fetch('/_hub/api/settings', { cache: 'no-store', headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : Promise.reject())).then((out) => {
      if (finished) return;
      key = mount(content, { state: out.linear, worked: finish, busy: (on) => doneBusy(wrap.querySelectorAll('[data-lk-done]'), on) });
    }).catch(() => { if (!finished) content.innerHTML = '<p class="note">Offline. Is the host awake?</p>'; });
    return result;
  }

  globalThis.LinearKey = { works, mount, open, doneBusy };
})();
