// Files attached to a composer: any element with data-composer="<id>" holding BoardUI.attachButton()
// and a [data-files] list. Picking files uploads them at once to the api/upload of the site named by the nearest
// [data-site] around the composer (a board view's root, app.js), else of the page's own site (ClaudeSite). Pending
// files live in memory by site and composer id, so a page that rebuilds its markup calls paintAll() to show them
// again, and a board the app shell switches away from keeps its own. site defaults to the page's own below.
//   BoardAttach.files(id, site)  the uploaded files, ready for an event's data.files
//   BoardAttach.busy(id, site)   true while any upload is running
//   BoardAttach.clear(id, site)  after sending
//   BoardAttach.onChange(fn)     fn(id) after each change, such as to disable Send while busy; each composer
//                                painted also gets a bubbling attach-change event with detail {id}
window.BoardAttach = (function () {
  const LIMIT = 20 * 1024 * 1024;
  const state = new Map();
  const listeners = [];
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
  }
  const paintAll = () => { for (const c of document.querySelectorAll('[data-composer]')) paint(c.dataset.composer, siteOf(c)); };

  function upload(site, id, file) {
    const p = { id: 'f' + ++seq, name: file.name || 'file', type: file.type || 'application/octet-stream', status: 'uploading', progress: 0 };
    if (/^image\//.test(p.type)) p.preview = URL.createObjectURL(file);
    state.set(keyOf(site, id), [...list(site, id), p]);
    if (file.size > LIMIT) { p.status = 'error'; p.error = 'Over 20 MB'; paint(id, site); return; }
    paint(id, site);
    const xhr = new XMLHttpRequest();
    p.xhr = xhr;
    xhr.open('POST', `${site}/api/upload`);
    xhr.setRequestHeader('x-filename', encodeURIComponent(p.name));
    xhr.setRequestHeader('content-type', p.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { p.progress = e.loaded / e.total; paint(id, site); } };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && body) { p.status = 'done'; p.file = body; }
      else { p.status = 'error'; p.error = xhr.status === 413 ? 'Over 20 MB' : (body && body.error) || 'Upload failed'; }
      paint(id, site);
    };
    xhr.onerror = () => { p.status = 'error'; p.error = 'Upload failed'; paint(id, site); };
    xhr.send(file);
  }

  function remove(site, id, fileId) {
    const p = list(site, id).find((x) => x.id === fileId);
    if (!p) return;
    if (p.status === 'uploading') p.xhr.abort();
    if (p.preview) URL.revokeObjectURL(p.preview);
    state.set(keyOf(site, id), list(site, id).filter((x) => x !== p));
    paint(id, site);
  }

  document.addEventListener('change', (ev) => {
    const input = ev.target.closest && ev.target.closest('input[data-attach]');
    const c = input && input.closest('[data-composer]');
    if (!c) return;
    for (const f of input.files) upload(siteOf(c), c.dataset.composer, f);
    input.value = '';
  });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-unattach]');
    const c = b && b.closest('[data-composer]');
    if (c) { ev.preventDefault(); remove(siteOf(c), c.dataset.composer, b.dataset.unattach); }
  });

  return {
    files: (id, site = own()) => list(site, id).filter((p) => p.status === 'done').map((p) => p.file),
    busy: (id, site = own()) => list(site, id).some((p) => p.status === 'uploading'),
    clear(id, site = own()) { for (const p of list(site, id)) if (p.preview) URL.revokeObjectURL(p.preview); state.delete(keyOf(site, id)); paint(id, site); },
    onChange(fn) { listeners.push(fn); },
    paint, paintAll,
  };
})();
