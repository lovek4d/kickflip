// The rules editor on Board Settings and on the Hub page
// (docs/adr/2026-10-29-1639-rules-live-on-settings-at-hub-and-board-level.md). Every change saves as it is made, an
// edit when focus leaves its box (docs/adr/2026-11-16-2000-edits-save-when-focus-leaves-them.md), an add or a removal
// at once: it hands {rules: [{id?, text}], base: [the ids it loaded]} to the page's save(), whose server merges it
// (hub/rules.mjs applyRules). It brings its own CSS, colours from colors.css only, and takes the page's button classes.
// rows, payload and render are pure, for ui.test.mjs; mount touches the DOM.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const one = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

  const rows = (rules) => (rules || []).map((r) => ({ key: r.id, id: r.id, text: r.text, by: r.by }));
  const payload = (list) => ({
    rules: list.map((r) => (r.id ? { id: r.id, text: r.text } : { text: r.text })),
    base: list.filter((r) => r.id).map((r) => r.id),
  });

  // editing: the key of the row open for editing, its box holding text when the save of it failed. buttons: the page's
  // {quiet, icon} classes; icon is ✕'s.
  function render(list, { readOnly = false, editing = null, text = null, buttons = {}, empty = 'No rules yet.' } = {}) {
    if (!list.length) return `<p class="muted small rule-empty">${esc(empty)}</p>`;
    const quiet = esc(buttons.quiet || '');
    return list.map((r) => {
      if (!readOnly && r.key === editing) {
        return `<div class="rule editing" data-key="${esc(r.key)}"><textarea class="rule-input" rows="3" aria-label="Rule text">${esc(text ?? r.text)}</textarea></div>`;
      }
      const meta = r.by === 'claude' ? '<div class="rule-meta"><span class="rule-by">Added by Claude</span></div>' : '';
      const actions = readOnly ? '' : `<div class="rule-actions"><button type="button" class="${quiet}" data-act="edit" aria-label="Edit this rule">Edit</button>
        <button type="button" class="${esc(buttons.icon ?? buttons.quiet ?? '')}" data-act="remove" aria-label="Remove this rule">✕</button></div>`;
      return `<div class="rule" data-key="${esc(r.key)}"><div class="rule-body"><div class="rule-text">${esc(r.text)}</div>${meta}</div>${actions}</div>`;
    }).join('');
  }

  const CSS = `.rules-editor .rule { display:flex; align-items:flex-start; gap:8px; padding:9px 10px; margin:6px 0; border:1px solid var(--line); border-radius:9px; background:var(--panel); }
.rules-editor .rule.editing { flex-direction:column; align-items:stretch; }
.rules-editor .rule-body { flex:1; min-width:0; }
.rules-editor .rule-text { overflow-wrap:anywhere; }
.rules-editor .rule-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; font-size:12px; color:var(--muted); }
.rules-editor .rule-by { padding:0 6px; border-radius:6px; background:var(--chip); color:var(--muted); }
.rules-editor .rule-actions { flex:none; display:flex; gap:4px; }
.rules-editor textarea { box-sizing:border-box; width:100%; min-width:0; resize:vertical; font:inherit; font-size:16px; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px 8px; }
.rules-editor .rule-add { display:flex; align-items:flex-end; gap:6px; margin-top:8px; }
.rules-editor .rule-add textarea { flex:1; }
.rules-editor .rule-status { min-height:1em; margin-top:6px; font-size:12px; color:var(--muted); }`;

  // opts: {rules, readOnly, buttons, empty, placeholder, save(payload) → Promise<{rules, message}>}. Sets data-dirty on
  // el while a box is open or holds text, so a page that reloads itself can wait.
  function mount(el, opts) {
    if (!document.getElementById('rules-editor-css')) document.head.insertAdjacentHTML('beforeend', `<style id="rules-editor-css">${CSS}</style>`);
    const b = opts.buttons || {};
    let list = rows(opts.rules);
    let editing = null;
    let typed = null;
    el.classList.add('rules-editor');
    el.innerHTML = `<div class="rule-list"></div>${opts.readOnly ? '' : `<form class="rule-add"><textarea rows="2" placeholder="${esc(opts.placeholder || 'Add a rule')}" aria-label="New rule"></textarea><button type="submit" class="${esc(b.quiet || '')}">Add</button></form>
      <div class="rule-status" role="status"></div>`}`;
    const listEl = el.querySelector('.rule-list');
    const addBox = el.querySelector('.rule-add textarea');
    const status = el.querySelector('.rule-status');
    function mark() {
      if (editing !== null || addBox.value.trim()) el.dataset.dirty = ''; else delete el.dataset.dirty;
    }
    function draw() {
      listEl.innerHTML = render(list, { readOnly: opts.readOnly, editing, text: typed, buttons: b, empty: opts.empty });
      if (opts.readOnly) return;
      mark();
      const input = listEl.querySelector('.rule-input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
    draw();
    if (opts.readOnly) return { set(rules) { list = rows(rules); draw(); } };
    // True once the page has the list; on a refusal the status says so and the caller keeps what the owner typed.
    async function save(next) {
      status.textContent = 'Saving…';
      try {
        const r = await opts.save(payload(next));
        list = rows(r.rules);
        status.textContent = r.message || 'Saved.';
        return true;
      } catch (e) {
        status.textContent = (e && e.message) || 'Could not save. Is the host awake?';
        return false;
      }
    }
    // Leaving a rule's box saves it, an emptied or unchanged one reverts; Escape reverts without leaving.
    async function leaveEdit(input) {
      const row = list.find((r) => r.key === editing);
      const text = one(input.value);
      if (!text || text === row.text) { editing = null; typed = null; draw(); return; }
      typed = text;
      if (await save(list.map((r) => (r === row ? { ...r, text } : r)))) { editing = null; typed = null; }
      draw();
    }
    listEl.addEventListener('keydown', (ev) => {
      if (!ev.target.matches('.rule-input')) return;
      if (ev.key === 'Escape') { editing = null; typed = null; draw(); }
      else if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); leaveEdit(ev.target); }
    });
    listEl.addEventListener('focusout', (ev) => { if (editing !== null && ev.target.matches('.rule-input')) leaveEdit(ev.target); });
    listEl.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      const row = btn && list.find((r) => r.key === btn.closest('.rule').dataset.key);
      if (!row) return;
      if (btn.dataset.act === 'edit') { editing = row.key; typed = null; status.textContent = ''; draw(); return; }
      await save(list.filter((r) => r !== row));
      draw();
    });
    const add = async () => {
      const text = one(addBox.value);
      if (!text) return;
      addBox.value = '';
      if (!(await save([...list, { id: null, text, by: 'owner' }]))) addBox.value = text;
      draw();
    };
    el.querySelector('.rule-add').addEventListener('submit', (ev) => { ev.preventDefault(); add(); });
    // A rule is one line, so Enter adds it; leaving the box adds it too.
    addBox.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); add(); } });
    addBox.addEventListener('focusout', add);
    addBox.addEventListener('input', mark);
    return { set(rules) { list = rows(rules); editing = null; typed = null; draw(); } };
  }

  globalThis.RulesEditor = { rows, payload, render, mount, CSS };
})();
