// SlackEmoji: Hub › Slack's emoji for each PR state's reaction on its Slack messages, each status a Slack message on a
// Slack-filed task shows (docs/adr/2026-11-23-0010-a-slack-message-on-a-task-shows-where-it-stands-as-one-reaction.md), and the signature that ends every
// message the hub posts (docs/adr/2026-11-18-0434-a-prs-state-is-reactions-again-and-the-signature-is-picked.md), under
// the token slot (linear-key.js) while the token works. A row per state and the signature, worded by hub/views.mjs prEmojiView from GET
// /_hub/api/slack-emoji; its cell opens a popup (popup.js) grid of the workspace's own emoji, then the standard ones, with a
// search by name. A pick, or a changed row's Use default, saves at once through POST /_hub/settings/slack-emoji.
(function () {
  const FAILED = 'Could not save. Is the host awake?';
  const UNLOADED = 'Could not load the workspace’s emoji. Is the host awake?';
  const TILES = {
    approved: ['check', 'var(--color-success)'], merged: ['merge', 'var(--color-merged)'], closed: ['x', 'var(--color-danger)'],
    received: ['eye', 'var(--color-info)'], thinking: ['clock', 'var(--color-notice)'], waiting: ['bell', 'var(--color-danger)'], done: ['check', 'var(--color-success)'],
    signature: ['pen', 'var(--accent)'],
  };

  // Draws the rows into root while on, the token working. → {set(on), destroy()}
  function mount(root, { on }) {
    const { esc, tile } = HubUI;
    let view = null, loading = false, open = null, query = '', flash = null, saving = false, destroyed = false;
    const glyph = (e) => (e.url ? `<img class="se-img" src="${esc(e.url)}" alt="">` : e.char ? `<span class="se-char">${e.char}</span>` : `<span class="se-name">:${esc(e.name)}:</span>`);
    const grid = (list, current) => list.map((e) => `<button type="button" class="se-pick${e.name === current ? ' sel' : ''}" data-se-pick="${esc(e.name)}" title=":${esc(e.name)}:" aria-label=":${esc(e.name)}:"${e.name === current ? ' aria-pressed="true"' : ''}>${glyph(e)}</button>`).join('');
    function found(current) {
      const words = query.trim().toLowerCase().replace(/:/g, '');
      const own = view.customs.filter((e) => e.name.includes(words));
      const standard = view.standard.filter((e) => e.name.includes(words));
      if (!own.length && !standard.length) return `<p class="se-sec">No emoji match “${esc(query.trim())}”</p>`;
      return `${own.length ? `<p class="se-sec">This workspace</p><div class="se-grid">${grid(own, current)}</div>` : ''}${standard.length ? `<p class="se-sec">Standard</p><div class="se-grid">${grid(standard, current)}</div>` : ''}`;
    }
    const popover = (r) => `<div class="se-pop" role="dialog" aria-label="${esc(r.title)} emoji"><input class="se-q" type="search" placeholder="Search emoji" aria-label="Search emoji" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(query)}">`
      + `<div class="se-found">${found(r.emoji.name)}</div><p class="se-sec se-now">:${esc(r.emoji.name)}: now</p></div>`;
    const row = (r) => `<div class="row se-row">${tile(...TILES[r.kind])}<span class="body"><span class="text"><span class="title">${esc(r.title)}${r.tag ? ` <span class="se-tag">${esc(r.tag)}</span>` : ''}</span>`
      + `<span class="sub wrap">${esc(r.sub)}${r.changed ? ` · <button type="button" class="link se-default" data-se-default="${r.kind}"${saving ? ' disabled' : ''}>Use default</button>` : ''}</span></span>`
      + `<button type="button" class="se-cell" data-se-open="${r.kind}" aria-haspopup="dialog" aria-expanded="${open === r.kind}" aria-label="${esc(r.title)} emoji, :${esc(r.emoji.name)}:"${saving ? ' disabled' : ''}>${glyph(r.emoji)}<span aria-hidden="true">▾</span></button></span>`
      + `${open === r.kind ? popover(r) : ''}</div>`;
    function paint() {
      if (!on) { root.innerHTML = ''; return; }
      if (!view) { root.innerHTML = flash ? HubUI.flash(flash) : '<p class="note">Loading the workspace’s emoji…</p>'; return; }
      root.innerHTML = `<h2 class="label">${esc(view.label)}</h2>${HubUI.flash(flash)}${view.warning ? HubUI.flash({ text: view.warning, error: true }) : ''}<div class="group se-rows">${view.rows.map(row).join('')}</div><p class="note">${esc(view.note)}</p>`;
      if (!open) return;
      Popup.open(root.querySelector('.se-pop'), root.querySelector(`[data-se-open="${open}"]`), { align: 'end', onClose: close });
      root.querySelector('.se-q').focus({ preventScroll: true });
    }
    async function load() {
      loading = true;
      try {
        const r = await fetch('/_hub/api/slack-emoji', { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error();
        view = await r.json();
        flash = null;
      } catch { flash = { text: UNLOADED, error: true }; }
      loading = false;
      if (!destroyed) paint();
    }
    async function save(kind, emoji) {
      saving = true;
      open = null;
      flash = null;
      paint();
      try {
        const r = await fetch('/_hub/settings/slack-emoji', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: kind, emoji }) });
        const out = await r.json().catch(() => null);
        if (r.ok && out) view = out; else flash = { text: out?.error || FAILED, error: true };
      } catch { flash = { text: FAILED, error: true }; }
      saving = false;
      if (!destroyed) paint();
    }
    // The grid's popup closed on a tap outside it or Escape, which puts the focus back on its cell.
    const close = (escaped) => {
      const kind = open;
      open = null;
      paint();
      if (escaped) root.querySelector(`[data-se-open="${kind}"]`).focus({ preventScroll: true });
    };
    const onClick = (e) => {
      const cell = e.target.closest?.('[data-se-open]');
      const pick = e.target.closest?.('[data-se-pick]');
      const reset = e.target.closest?.('[data-se-default]');
      if (cell) { query = ''; open = open === cell.dataset.seOpen ? null : cell.dataset.seOpen; paint(); }
      else if (pick && open && !saving) save(open, pick.dataset.sePick);
      else if (reset && !saving) save(reset.dataset.seDefault, '');
    };
    // Typing redraws only the grid, so the search box keeps its focus and caret.
    const onInput = (e) => {
      if (!e.target.matches?.('.se-q')) return;
      query = e.target.value;
      root.querySelector('.se-found').innerHTML = found(view.rows.find((r) => r.kind === open).emoji.name);
    };
    const listeners = [['click', onClick], ['input', onInput]];
    for (const [type, fn] of listeners) root.addEventListener(type, fn);
    const set = (next) => {
      on = next;
      if (on && !view && !loading) load();
      paint();
    };
    set(on);
    return {
      set,
      destroy() { destroyed = true; for (const [type, fn] of listeners) root.removeEventListener(type, fn); },
    };
  }

  globalThis.SlackEmoji = { mount };
})();
