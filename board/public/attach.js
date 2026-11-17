// docs/adr/2026-11-03-1722-every-text-box-attaches-through-attach-js.md
// Files attached to a composer: any element with data-composer="<id>" holding its text box in BoardUI.dropZone(), which
// puts BoardUI.attachButton() inside the box, and a [data-files] list. Picking files, dropping them on the composer, or pasting them into it
// uploads them at once to the api/upload of the site named by the nearest
// [data-site] around the composer (a board view's root, app.js), else of the page's own site (ClaudeSite). Pending
// files live in memory by site and composer id, so a page that rebuilds its markup calls paintAll() to show them
// again, and a board the app shell switches away from keeps its own. site defaults to the page's own below.
//   BoardAttach.files(id, site)  the uploaded files, ready for an event's data.files
//   BoardAttach.busy(id, site)   true while any upload is running
//   BoardAttach.clear(id, site)  after sending
//   BoardAttach.settled(id, site) a promise, once no upload runs, of whether every file is up (none failed)
//   BoardAttach.restore(id, files, site) puts files back as chips: each an uploaded file, or one of saved()'s
//                                {name, type, lost} as failed, Lost in a reload, which no retry can change
//   BoardAttach.onChange(fn)     fn(id) after each change, such as to repaint a New strip row; it returns the
//                                unsubscribe. Each composer painted also gets a bubbling attach-change event with detail {id}
// A New task's, a thread reply's and a question's answer's send takes its composer's files, uploads still running, into a
// box of its own, send:<send id> (docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md,
// docs/adr/2026-11-16-1030-a-thread-replys-and-an-answers-attachments-send-atomically-with-thumbnails.md):
//   BoardAttach.move(from, to, site)  moves every file, its upload with it, from one id to another, after any already there
//   BoardAttach.list(id, site)   the files as pendingFiles reads them, for a page that draws them itself
//   BoardAttach.retryFailed(id, site) uploads again every failed file a retry can change
//   BoardAttach.saved(id, site)  the files as JSON for a reload: an uploaded one as sent, another {name, type, lost: true}
// A [data-uploads="<id>"] box's X removes its file as a composer's does.
window.BoardAttach = (function () {
  const LIMIT = 20 * 1024 * 1024;
  const OVER = 'Over 20 MB';
  const state = new Map();
  const listeners = [];
  // By site and composer id, the resolves of settled() calls waiting for its uploads.
  const waiters = new Map();
  const running = (site, id) => list(site, id).some((p) => p.status === 'uploading');
  const allUp = (site, id) => !list(site, id).some((p) => p.status === 'error');
  let seq = 0;
  const own = () => ClaudeSite.root;
  const siteOf = (el) => el.closest('[data-site]')?.dataset.site || own();
  const keyOf = (site, id) => `${site}|${id}`;
  const list = (site, id) => state.get(keyOf(site, id)) || [];
  const composers = (site, id) => [...document.querySelectorAll(`[data-composer="${CSS.escape(id)}"]`)].filter((c) => siteOf(c) === site);

  function paint(id, site = own()) {
    for (const c of composers(site, id)) {
      const el = c.querySelector('[data-files]');
      if (el) el.innerHTML = BoardUI.pendingFiles(list(site, id));
      c.dispatchEvent(new CustomEvent('attach-change', { bubbles: true, detail: { id } }));
    }
    for (const fn of listeners) fn(id);
    const waiting = waiters.get(keyOf(site, id));
    if (!waiting || running(site, id)) return;
    waiters.delete(keyOf(site, id));
    for (const resolve of waiting) resolve(allUp(site, id));
  }
  const paintAll = () => { for (const c of document.querySelectorAll('[data-composer]')) paint(c.dataset.composer, siteOf(c)); };

  // Each file knows the id it is under (box), which move changes, so an upload still running paints where it now is.
  // A final error ("Over 20 MB", lost in a reload) is one a retry can't change.
  function upload(site, id, file) {
    const p = { id: 'f' + ++seq, box: id, name: file.name || 'file', type: file.type || 'application/octet-stream', status: 'uploading', progress: 0, source: file };
    if (/^image\//.test(p.type)) p.preview = URL.createObjectURL(file);
    state.set(keyOf(site, id), [...list(site, id), p]);
    if (file.size > LIMIT) { Object.assign(p, { status: 'error', error: OVER, final: true }); paint(id, site); return; }
    send(site, p);
  }

  // Sends p's File and paints it uploading; a retry from an error chip runs it again.
  function send(site, p) {
    const file = p.source;
    p.status = 'uploading'; p.progress = 0; delete p.error;
    paint(p.box, site);
    const xhr = new XMLHttpRequest();
    p.xhr = xhr;
    xhr.open('POST', `${site}/api/upload`);
    xhr.setRequestHeader('x-filename', encodeURIComponent(p.name));
    xhr.setRequestHeader('content-type', p.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { p.progress = e.loaded / e.total; paint(p.box, site); } };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && body) { p.status = 'done'; p.file = body; }
      else if (xhr.status === 413) Object.assign(p, { status: 'error', error: OVER, final: true });
      else { p.status = 'error'; p.error = (body && body.error) || 'Upload failed'; }
      paint(p.box, site);
    };
    xhr.onerror = () => { p.status = 'error'; p.error = 'Upload failed'; paint(p.box, site); };
    xhr.send(file);
  }

  const retryable = (p) => p.status === 'error' && !p.final;
  function retry(site, id, fileId) {
    const p = list(site, id).find((x) => x.id === fileId);
    if (p && retryable(p)) send(site, p);
  }

  function remove(site, id, fileId) {
    const p = list(site, id).find((x) => x.id === fileId);
    if (!p) return;
    if (p.status === 'uploading') p.xhr.abort();
    if (p.preview) URL.revokeObjectURL(p.preview);
    state.set(keyOf(site, id), list(site, id).filter((x) => x !== p));
    paint(id, site);
  }

  // Pressing the button does not take focus from the text box, so the cursor stays where it was while the picker opens
  // (iOS may still hide the keyboard for its picker), and a pick puts focus back in the box that held it.
  let focused = null;
  document.addEventListener('mousedown', (ev) => {
    const input = ev.target.closest && ev.target.closest('input[data-attach]');
    if (!input) return;
    const a = document.activeElement;
    focused = a && a.tagName === 'TEXTAREA' && input.closest('[data-composer]')?.contains(a) ? a : null;
    ev.preventDefault();
  });
  // Pressing a composer's send button, or its Prototype, Grill or Visual, does not take focus from the text box either: on a
  // phone a blur starts closing the keyboard, and the send bar riding on it would slide out from under the finger
  // before the click lands. The click's own handler closes the keyboard once it sends (app-threads.js post, new-task.js).
  document.addEventListener('mousedown', (ev) => {
    const b = ev.target.closest && ev.target.closest('button[type=submit], button[data-proto], button[data-grill], button[data-visual], button[data-review]');
    if (b && b.closest('[data-composer]')) ev.preventDefault();
  });
  document.addEventListener('change', (ev) => {
    const input = ev.target.closest && ev.target.closest('input[data-attach]');
    const c = input && input.closest('[data-composer]');
    if (!c) return;
    addFiles(c, input.files);
    input.value = '';
    if (focused) focused.focus({ preventScroll: true });
    focused = null;
  });
  // A drag of files over a composer marks it .dragging, which outlines its drop zone. dragenter and dragleave fire on
  // each child it crosses, so the composer counts them, and a drop ends the drag.
  const depth = new WeakMap();
  const composerOf = (ev) => (ev.target.closest && ev.target.closest('[data-composer]')) || null;
  const carriesFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
  const setDepth = (c, n) => { depth.set(c, n); c.classList.toggle('dragging', n > 0); };
  const addFiles = (c, files) => { for (const f of files) upload(siteOf(c), c.dataset.composer, f); };
  document.addEventListener('dragenter', (ev) => {
    const c = composerOf(ev);
    if (c && carriesFiles(ev)) setDepth(c, (depth.get(c) || 0) + 1);
  });
  document.addEventListener('dragleave', (ev) => {
    const c = composerOf(ev);
    if (c && depth.get(c)) setDepth(c, depth.get(c) - 1);
  });
  // A file drag is taken anywhere on the page, so a drop that misses every composer does nothing in place of the
  // browser opening the file over the board.
  document.addEventListener('dragover', (ev) => { if (carriesFiles(ev)) ev.preventDefault(); });
  document.addEventListener('drop', (ev) => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    const c = composerOf(ev);
    if (!c) return;
    setDepth(c, 0);
    addFiles(c, ev.dataTransfer.files);
  });
  // A paste that carries files attaches them in place of pasting; a paste of text alone pastes as usual.
  document.addEventListener('paste', (ev) => {
    const c = composerOf(ev);
    const files = [...(ev.clipboardData?.files || [])];
    if (!c || !files.length) return;
    ev.preventDefault();
    addFiles(c, files);
  });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-unattach]');
    const c = b && b.closest('[data-composer], [data-uploads]');
    if (c) { ev.preventDefault(); remove(siteOf(c), c.dataset.composer || c.dataset.uploads, b.dataset.unattach); return; }
    const r = ev.target.closest && ev.target.closest('[data-retry]');
    const rc = r && r.closest('[data-composer]');
    if (rc) { ev.preventDefault(); retry(siteOf(rc), rc.dataset.composer, r.dataset.retry); }
  });

  return {
    files: (id, site = own()) => list(site, id).filter((p) => p.status === 'done').map((p) => p.file),
    busy: (id, site = own()) => running(site, id),
    settled(id, site = own()) {
      if (!running(site, id)) return Promise.resolve(allUp(site, id));
      return new Promise((resolve) => waiters.set(keyOf(site, id), [...(waiters.get(keyOf(site, id)) || []), resolve]));
    },
    restore(id, files, site = own()) {
      const back = files.map((f) => ({ id: 'f' + ++seq, box: id, name: f.name || 'file', type: f.type || 'application/octet-stream',
        ...(f.lost ? { status: 'error', error: 'Lost in a reload', final: true } : { status: 'done', file: f }) }));
      state.set(keyOf(site, id), [...list(site, id), ...back]);
      paint(id, site);
    },
    clear(id, site = own()) { for (const p of list(site, id)) if (p.preview) URL.revokeObjectURL(p.preview); state.delete(keyOf(site, id)); paint(id, site); },
    onChange(fn) {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
    move(from, to, site = own()) {
      const moving = list(site, from);
      for (const p of moving) p.box = to;
      state.delete(keyOf(site, from));
      state.set(keyOf(site, to), [...list(site, to), ...moving]);
      paint(from, site);
      paint(to, site);
    },
    list: (id, site = own()) => list(site, id),
    retryFailed(id, site = own()) { for (const p of list(site, id).filter(retryable)) send(site, p); },
    saved: (id, site = own()) => list(site, id).map((p) => (p.status === 'done' ? p.file : { name: p.name, type: p.type, lost: true })),
    paint, paintAll,
  };
})();
