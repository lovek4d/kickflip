// Files attached to a composer: any element with data-composer="<id>" holding BoardUI.attachButton()
// and a [data-files] list. Picking files uploads them to api/upload at once. Pending files live in
// memory by composer id, so a page that rebuilds its markup calls paintAll() to show them again.
//   BoardAttach.files(id)    the uploaded files, ready for an event's data.files
//   BoardAttach.busy(id)     true while any upload is running
//   BoardAttach.clear(id)    after sending
//   BoardAttach.onChange(fn) fn(id) after each change, such as to disable Send while busy; each composer
//                            painted also gets a bubbling attach-change event with detail {id}
window.BoardAttach = (function () {
  const LIMIT = 20 * 1024 * 1024;
  const state = new Map();
  const listeners = [];
  let seq = 0;
  const list = (id) => state.get(id) || [];
  const composers = (id) => document.querySelectorAll(`[data-composer="${CSS.escape(id)}"]`);

  function paint(id) {
    for (const c of composers(id)) {
      const el = c.querySelector('[data-files]');
      if (el) el.innerHTML = BoardUI.pendingFiles(list(id));
      c.dispatchEvent(new CustomEvent('attach-change', { bubbles: true, detail: { id } }));
    }
    for (const fn of listeners) fn(id);
  }
  const paintAll = () => { for (const c of document.querySelectorAll('[data-composer]')) paint(c.dataset.composer); };

  function upload(id, file) {
    const p = { id: 'f' + ++seq, name: file.name || 'file', type: file.type || 'application/octet-stream', status: 'uploading', progress: 0 };
    if (/^image\//.test(p.type)) p.preview = URL.createObjectURL(file);
    state.set(id, [...list(id), p]);
    if (file.size > LIMIT) { p.status = 'error'; p.error = 'Over 20 MB'; paint(id); return; }
    paint(id);
    const xhr = new XMLHttpRequest();
    p.xhr = xhr;
    xhr.open('POST', ClaudeSite.url('api/upload'));
    xhr.setRequestHeader('x-filename', encodeURIComponent(p.name));
    xhr.setRequestHeader('content-type', p.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { p.progress = e.loaded / e.total; paint(id); } };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && body) { p.status = 'done'; p.file = body; }
      else { p.status = 'error'; p.error = xhr.status === 413 ? 'Over 20 MB' : (body && body.error) || 'Upload failed'; }
      paint(id);
    };
    xhr.onerror = () => { p.status = 'error'; p.error = 'Upload failed'; paint(id); };
    xhr.send(file);
  }

  function remove(id, fileId) {
    const p = list(id).find((x) => x.id === fileId);
    if (!p) return;
    if (p.status === 'uploading') p.xhr.abort();
    if (p.preview) URL.revokeObjectURL(p.preview);
    state.set(id, list(id).filter((x) => x !== p));
    paint(id);
  }

  document.addEventListener('change', (ev) => {
    const input = ev.target.closest && ev.target.closest('input[data-attach]');
    const c = input && input.closest('[data-composer]');
    if (!c) return;
    for (const f of input.files) upload(c.dataset.composer, f);
    input.value = '';
  });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-unattach]');
    const c = b && b.closest('[data-composer]');
    if (c) { ev.preventDefault(); remove(c.dataset.composer, b.dataset.unattach); }
  });

  return {
    files: (id) => list(id).filter((p) => p.status === 'done').map((p) => p.file),
    busy: (id) => list(id).some((p) => p.status === 'uploading'),
    clear(id) { for (const p of list(id)) if (p.preview) URL.revokeObjectURL(p.preview); state.delete(id); paint(id); },
    onChange(fn) { listeners.push(fn); },
    paint, paintAll,
  };
})();
