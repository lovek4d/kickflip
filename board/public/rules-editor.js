// The rules editor on Board Settings and on the Hub page
// (docs/adr/0039-rules-live-on-settings-at-hub-and-board-level.md). Edits stay on the page until Save, as the
// reviewers list does; Save hands {rules: [{id?, text}], base: [the ids it loaded]} to the page's save(), whose
// server merges it (hub/rules.mjs applyRules). It brings its own CSS, colours from colors.css only, and takes the page's
// button classes. rows, payload, dirty and render are pure, for ui.test.mjs; mount touches the DOM.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const one = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

  // A row is a saved rule (orig is its saved text) or a new one (orig null); gone marks a staged removal.
  const rows = (rules) => (rules || []).map((r) => ({ key: r.id, id: r.id, text: r.text, by: r.by, orig: r.text, gone: false }));
  const payload = (list) => ({
    rules: list.filter((r) => !r.gone).map((r) => (r.id ? { id: r.id, text: r.text } : { text: r.text })),
    base: list.filter((r) => r.id).map((r) => r.id),
  });
  const dirty = (list) => list.some((r) => r.gone || r.orig === null || r.text !== r.orig);

  // editing: the key of the row open for editing. buttons: the page's {primary, quiet, icon} classes; icon is ✕'s.
  function render(list, { readOnly = false, editing = null, buttons = {}, empty = 'No rules yet.' } = {}) {
    if (!list.length) return `<p class="muted small rule-empty">${esc(empty)}</p>`;
    const quiet = esc(buttons.quiet || '');
    return list.map((r) => {
      if (!readOnly && r.key === editing) {
        return `<div class="rule editing" data-key="${esc(r.key)}"><textarea class="rule-input" rows="3" aria-label="Rule text">${esc(r.text)}</textarea>
          <div class="rule-edit-actions"><button type="button" class="${quiet}" data-act="cancel">Cancel</button><button type="button" class="${esc(buttons.primary || '')}" data-act="done">Done</button></div></div>`;
      }
      const state = r.gone ? 'gone' : r.orig === null ? 'new' : r.text !== r.orig ? 'edited' : '';
      const meta = [r.by === 'claude' ? '<span class="rule-by">Added by Claude</span>' : '', state && !readOnly ? `<span>${state === 'gone' ? 'removed' : state}</span>` : ''].join('');
      const actions = readOnly ? '' : `<div class="rule-actions">${r.gone ? '' : `<button type="button" class="${quiet}" data-act="edit" aria-label="Edit this rule">Edit</button>`}
        <button type="button" class="${esc(buttons.icon ?? buttons.quiet ?? '')}" data-act="${r.gone ? 'undo' : 'remove'}" aria-label="${r.gone ? 'Keep' : 'Remove'} this rule">${r.gone ? 'Undo' : '✕'}</button></div>`;
      return `<div class="rule${state ? ` ${state}` : ''}" data-key="${esc(r.key)}"><div class="rule-body"><div class="rule-text">${esc(r.text)}</div>${meta ? `<div class="rule-meta">${meta}</div>` : ''}</div>${actions}</div>`;
    }).join('');
  }

  const CSS = `.rules-editor .rule { display:flex; align-items:flex-start; gap:8px; padding:9px 10px; margin:6px 0; border:1px solid var(--line); border-radius:9px; background:var(--panel); }
.rules-editor .rule.new { border-color:var(--accent); }
.rules-editor .rule.gone .rule-text { opacity:.5; text-decoration:line-through; }
.rules-editor .rule.editing { flex-direction:column; align-items:stretch; }
.rules-editor .rule-body { flex:1; min-width:0; }
.rules-editor .rule-text { overflow-wrap:anywhere; }
.rules-editor .rule-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; font-size:12px; color:var(--muted); }
.rules-editor .rule-by { padding:0 6px; border-radius:6px; background:var(--chip); color:var(--muted); }
.rules-editor .rule-actions { flex:none; display:flex; gap:4px; }
.rules-editor textarea { box-sizing:border-box; width:100%; min-width:0; resize:vertical; font:inherit; font-size:16px; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px 8px; }
.rules-editor .rule-add { display:flex; align-items:flex-end; gap:6px; margin-top:8px; }
.rules-editor .rule-add textarea { flex:1; }
.rules-editor .rule-edit-actions, .rules-editor .rule-save { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:8px; }
.rules-editor .rule-save .rule-status { flex:1; min-width:0; font-size:12px; color:var(--muted); }`;

  // opts: {rules, readOnly, buttons, empty, placeholder, save(payload) → Promise<{rules, message}>}. Sets data-dirty on
  // el while anything is unsaved, so a page that reloads itself can wait.
  function mount(el, opts) {
    if (!document.getElementById('rules-editor-css')) document.head.insertAdjacentHTML('beforeend', `<style id="rules-editor-css">${CSS}</style>`);
    const b = opts.buttons || {};
    let list = rows(opts.rules);
    let editing = null;
    let added = 0;
    el.classList.add('rules-editor');
    el.innerHTML = `<div class="rule-list"></div>${opts.readOnly ? '' : `<form class="rule-add"><textarea rows="2" placeholder="${esc(opts.placeholder || 'Add a rule')}" aria-label="New rule"></textarea><button type="submit" class="${esc(b.quiet || '')}">Add</button></form>
      <div class="rule-save"><span class="rule-status" role="status"></span><button type="button" class="${esc(b.primary || '')}" data-act="save" disabled>Save</button></div>`}`;
    const listEl = el.querySelector('.rule-list');
    const addBox = el.querySelector('.rule-add textarea');
    const saveBtn = el.querySelector('[data-act="save"]');
    const status = el.querySelector('.rule-status');
    function mark() {
      const unsaved = dirty(list);
      saveBtn.disabled = !unsaved || editing !== null;
      if (unsaved || editing !== null || addBox.value.trim()) el.dataset.dirty = ''; else delete el.dataset.dirty;
    }
    function draw() {
      listEl.innerHTML = render(list, { readOnly: opts.readOnly, editing, buttons: b, empty: opts.empty });
      if (opts.readOnly) return;
      mark();
      const input = listEl.querySelector('.rule-input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
    draw();
    if (opts.readOnly) return { set(rules) { list = rows(rules); draw(); } };
    listEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.target.matches('.rule-input')) { ev.preventDefault(); listEl.querySelector('[data-act="done"]').click(); }
    });
    listEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      const row = btn && list.find((r) => r.key === btn.closest('.rule').dataset.key);
      if (!row) return;
      const act = btn.dataset.act;
      if (act === 'edit') editing = row.key;
      else if (act === 'cancel') editing = null;
      else if (act === 'done') {
        const text = one(listEl.querySelector('.rule-input').value);
        if (!text) return;
        row.text = text;
        editing = null;
      } else if (act === 'remove') {
        if (row.orig === null) list = list.filter((r) => r !== row); else row.gone = true;
      } else if (act === 'undo') row.gone = false;
      status.textContent = '';
      draw();
    });
    const add = () => {
      const text = one(addBox.value);
      if (!text) return;
      list.push({ key: `new-${++added}`, id: null, text, by: 'owner', orig: null, gone: false });
      addBox.value = '';
      status.textContent = '';
      draw();
    };
    el.querySelector('.rule-add').addEventListener('submit', (ev) => { ev.preventDefault(); add(); });
    // A rule is one line, so Enter adds it.
    addBox.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); add(); } });
    addBox.addEventListener('input', mark);
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      status.textContent = 'Saving…';
      try {
        const r = await opts.save(payload(list));
        list = rows(r.rules);
        editing = null;
        status.textContent = r.message || 'Saved.';
      } catch (e) { status.textContent = (e && e.message) || 'Could not save. Is the host awake?'; }
      draw();
    });
    return { set(rules) { list = rows(rules); editing = null; draw(); } };
  }

  globalThis.RulesEditor = { rows, payload, dirty, render, mount, CSS };
})();
