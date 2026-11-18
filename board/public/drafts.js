// docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md
// A view's composer drafts, kept on its site's server (board/drafts.mjs), so they follow the owner across devices and
// reloads: BoardDrafts.create(B) → B.drafts, for each [data-composer] box whose id is ask (New task) or item:<card key>
// (a thread reply). A draft is the box's text and its uploaded files. It goes to POST <site>/api/drafts after a pause
// of PAUSE_MS in typing, as the box loses focus, as its files change with none still uploading, and as the page hides
// or the view unmounts. One box's saves go one at a time, and a save of what the server already has sends nothing.
// The site's answers carry every draft, {id: {text, files, at}}, at the server's time of its last save, which the view
// hands to take: a draft newer than the page has fills its box and files, except a box with focus, a pause still
// running or a save that failed, which keeps what is typed and saves it over the newer one: the last save wins.
//   B.drafts.take(drafts, cards)   a site answer's drafts, and the keys of the cards it shows
//   B.drafts.text(id)              the text a box drawn anew starts with
//   B.drafts.put(id, text)         puts text in the box, drawn or not, and saves it (an unsent message back in it)
//   B.drafts.send(id, ta, current, run)  Send: blurs ta, runs run(), then empties the box (current(), as drawn now)
//                                  and its draft; a failed run keeps both. Input is dropped meanwhile and for a moment
//                                  after, since iOS commits a pending predictive-text word after Send empties the box.
// Load this after attach.js and before app.js.
globalThis.BoardDrafts = (function () {
  const PAUSE_MS = 1000;
  const QUIET_MS = 1000;
  const KEPT = /^(ask|item:.+)$/;
  const EMPTY = Object.freeze({ text: '', files: [] });
  const same = (a, b) => a.text === b.text && JSON.stringify(a.files.map((f) => f.url)) === JSON.stringify(b.files.map((f) => f.url));
  // This browser's drafts from before they lived on the server: the store key each box kept its text under.
  const localKey = (id) => (id === 'ask' ? 'draft:ask' : 'draft:' + id.slice('item:'.length));

  function create(B) {
    const site = B.site.root;
    // id → the newest {text, files, at} the server has, as far as this page has heard.
    const known = new Map();
    // id → the {text, files} the box last held in step with the server: as drawn, taken or saved.
    const synced = new Map();
    // id → the cancel of the box's pause timer.
    const waiting = new Map();
    // id → the box's saves, one after another.
    const chains = new Map();
    const quiet = new Map();
    // The box take is putting a draft's files in, whose attach changes save nothing.
    let restoring = null;
    let moved = false;

    const box = (id) => B.$(`[data-composer="${CSS.escape(id)}"] textarea`);
    const idOf = (el) => {
      if (el?.tagName !== 'TEXTAREA') return null;
      const id = el.closest?.('[data-composer]')?.dataset.composer;
      return id && KEPT.test(id) ? id : null;
    };
    const held = (id) => ({ text: box(id)?.value ?? synced.get(id)?.text ?? '', files: BoardAttach.files(id, site) });
    const quieted = (id) => (quiet.get(id) || 0) > Date.now();

    function post(id, draft, keepalive = false) {
      synced.set(id, draft);
      const run = (chains.get(id) || Promise.resolve()).then(async () => {
        const r = await fetch(B.site.url('api/drafts'), { method: 'POST', keepalive, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...draft }) });
        if (!r.ok) throw new Error(`drafts ${r.status}`);
        const { at } = await r.json();
        if (at > (known.get(id)?.at || '')) known.set(id, { ...draft, at });
      }).catch(() => { if (synced.get(id) === draft) synced.delete(id); });
      chains.set(id, run);
      return run;
    }
    function save(id, { text, keepalive = false } = {}) {
      waiting.get(id)?.();
      waiting.delete(id);
      const draft = { ...held(id), ...(text === undefined ? {} : { text }) };
      if (same(draft, synced.get(id) ?? EMPTY)) return chains.get(id);
      return post(id, draft, keepalive);
    }
    const saveAll = () => { for (const id of [...waiting.keys()]) save(id, { keepalive: true }); };

    // The drafts this browser kept itself move to the server once, each where the server has none for its box.
    function moveLocal(drafts, cards) {
      if (moved) return;
      moved = true;
      for (const id of ['ask', ...cards.map((k) => 'item:' + k)]) {
        const text = B.store.get(localKey(id), null);
        if (text === null) continue;
        B.store.remove(localKey(id));
        if (typeof text !== 'string' || !text || drafts[id]) continue;
        const ta = box(id);
        if (ta && !ta.value) ta.value = text;
        known.set(id, { text, files: [], at: '' });
        post(id, { text, files: [] });
      }
    }

    function take(drafts, cards = []) {
      if (!drafts) return;
      moveLocal(drafts, cards);
      for (const [id, d] of Object.entries(drafts)) {
        if (d.at <= (known.get(id)?.at || '')) continue;
        const mine = held(id);
        known.set(id, d);
        const ta = box(id);
        if (waiting.has(id) || (ta && document.activeElement === ta) || !same(mine, synced.get(id) ?? EMPTY)) continue;
        synced.set(id, { text: d.text, files: d.files });
        if (ta) ta.value = d.text;
        if (BoardAttach.busy(id, site) || same({ ...mine, text: '' }, { ...d, text: '' })) continue;
        // The box's files change to the draft's, which saves nothing back.
        restoring = id;
        try {
          BoardAttach.clear(id, site);
          BoardAttach.restore(id, d.files, site);
        } finally { restoring = null; }
      }
    }

    function text(id) {
      const d = known.get(id);
      if (!d) return '';
      synced.set(id, { text: d.text, files: d.files });
      return d.text;
    }

    function put(id, value) {
      const ta = box(id);
      if (ta) ta.value = value;
      return save(id, { text: value });
    }

    async function send(id, ta, current, run) {
      quiet.set(id, Infinity);
      ta.blur();
      waiting.get(id)?.();
      waiting.delete(id);
      try { await run(); } catch (e) { quiet.delete(id); save(id); throw e; }
      const now = current();
      if (now) now.value = '';
      save(id, { text: '' });
      quiet.set(id, Date.now() + QUIET_MS);
    }

    B.on(B.root, 'input', (ev) => {
      const id = idOf(ev.target);
      if (!id) return;
      if (quieted(id)) {
        if (quiet.get(id) !== Infinity) ev.target.value = '';
        return;
      }
      waiting.get(id)?.();
      waiting.set(id, B.later(PAUSE_MS, () => { waiting.delete(id); save(id); }));
    });
    B.on(B.root, 'focusout', (ev) => {
      const id = idOf(ev.target);
      if (id && !quieted(id)) save(id);
    });
    B.on(document, 'visibilitychange', () => { if (document.hidden) saveAll(); });
    B.on(window, 'pagehide', saveAll);
    B.atUnmount(saveAll);
    B.atUnmount(BoardAttach.onChange((id) => { if (KEPT.test(id) && id !== restoring && !BoardAttach.busy(id, site) && !quieted(id)) save(id); }));

    return { take, text, put, send };
  }

  return { create };
})();
