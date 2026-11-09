// The reader sheet (docs/adr/2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md): a thread's "View transcript"
// (ui-threads.js) and a card's or a wave's Notes (app-cards.js, app-lanes.js) open over the board in one sheet in
// place of log.html and notes.html, which still open on their own. It closes on its ✕, Escape, a tap on the dim area
// and Back, through a history entry of its own that carries the board's URL, so the router's pop keeps the board.
// A link in it closes it first, then opens through the shell.
// A log written as a stream (headless.mjs: one stream-json event per line) reads as the run's transcript, the whole of
// it as GET /api/transcript's rows: what Claude says, and each tool call as one line whose output opens on a tap, with a
// raw toggle for the file as it is (docs/adr/2026-11-07-1224-view-transcript-reads-the-whole-run-as-rows.md); any other
// log reads as its text. Every 3 seconds until the run's result arrives it reads on from where it left off, and follows
// new lines while read at its end.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc, markdown, linkContext } = BoardUI;
  const sheet = $('#readerSheet');
  const body = sheet.querySelector('.reader-body');
  const tools = sheet.querySelector('.reader-tools');
  const more = sheet.querySelector('.reader-new');
  let opened = 0;
  let pushed = false;
  let pending = null;
  let log = null;
  let stopReading = null;

  // A row of the transcript (transcript.mjs); a call with its output opens it on a tap of its line.
  function rowHtml(r, i) {
    const tag = r.label ? `<span class="reader-tag">${esc(r.label)}</span>` : '';
    if (r.out === undefined) return `<div class="reader-row ${r.kind}">${tag}${esc(r.body)}</div>`;
    const on = log.opened.has(i);
    return `<div class="reader-row tool call" data-call="${i}"><span class="reader-caret">${on ? '▾' : '▸'}</span>${tag}${esc(r.body)}</div>${on ? `<div class="reader-out">${esc(r.out)}</div>` : ''}`;
  }

  const atEnd = () => body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const toEnd = () => { body.scrollTop = body.scrollHeight; };
  function drawTools() {
    if (!log?.stream) { tools.innerHTML = ''; return; }
    const word = log.finished ? 'finished' : log.following ? 'following' : 'paused';
    tools.innerHTML = `<span class="reader-status${word === 'following' ? ' on' : ''}">${word}</span><button type="button" data-reader="raw" aria-pressed="${log.raw}">raw</button>`;
  }
  function drawMore() {
    more.hidden = !log?.unseen;
    if (log?.unseen) more.textContent = `${log.unseen} new ${log.unseen === 1 ? 'line' : 'lines'} ↓`;
  }
  function drawLog() {
    const { rows, stream, raw, text } = log;
    body.innerHTML = !rows.length ? '<p class="muted reader-empty">The log is empty so far.</p>'
      : !stream ? `<pre class="reader-text">${esc(rows.map((r) => `${r.body}\n`).join(''))}</pre>`
      : raw ? (text === null ? '<p class="muted">Loading…</p>' : `<pre class="reader-raw">${esc(text)}</pre>`)
      : rows.map(rowHtml).join('');
    drawTools();
    drawMore();
  }
  function follow() {
    log.following = true;
    log.unseen = 0;
    toEnd();
    drawTools();
    drawMore();
  }

  // Reads the transcript on from where the last read ended; an output joins its call's line.
  async function readLog(n) {
    let answer;
    try {
      const r = await fetch(B.site.url(`api/transcript?file=${encodeURIComponent(log.file)}&from=${log.next}`), { cache: 'no-store' });
      answer = { ok: r.ok, ...(await r.json()) };
    } catch { answer = null; }
    if (n !== opened) return;
    if (answer && !answer.ok) { body.innerHTML = `<p class="muted">${esc(answer.error || 'Could not load this log.')}</p>`; return; }
    if (answer && (!log.read || answer.next !== log.next)) {
      let added = 0;
      for (const row of answer.rows) {
        if (row.for) { log.calls.get(row.for).out = row.body; continue; }
        if (row.id) log.calls.set(row.id, row);
        log.rows.push(row);
        added++;
      }
      Object.assign(log, { read: true, next: answer.next, stream: log.stream || answer.stream, finished: log.finished || answer.finished });
      if (!log.following) log.unseen += added;
      drawLog();
      if (log.following) toEnd();
      if (log.raw) readRaw(n);
    }
    if (!log.finished) stopReading = B.later(3000, () => readLog(n));
  }
  // The raw toggle's file as it is: GET /api/log, its last 256 KiB.
  async function readRaw(n) {
    let text;
    try {
      const r = await fetch(B.site.url(`api/log?file=${encodeURIComponent(log.file)}`), { cache: 'no-store' });
      const answer = await r.json();
      text = r.ok ? answer.text : answer.error;
    } catch { text = 'Could not load this log.'; }
    if (n !== opened || !log.raw) return;
    log.text = text;
    drawLog();
    if (log.following) toEnd();
  }

  function show(title, ref) {
    opened++;
    stopReading?.();
    log = null;
    sheet.querySelector('#readerTitle').textContent = title;
    sheet.querySelector('.reader-ref').textContent = ref;
    tools.innerHTML = '';
    more.hidden = true;
    body.innerHTML = '<p class="muted">Loading…</p>';
    sheet.showModal();
    history.pushState({ ...history.state, idx: history.state.idx + 1, reader: true }, '', location.href);
    pushed = true;
    return opened;
  }
  function openLog(file) {
    const n = show(`${file.split('-')[0]} transcript`, file);
    log = { file, read: false, next: 0, rows: [], calls: new Map(), opened: new Set(), stream: false, finished: false, raw: false, text: null, following: true, unseen: 0 };
    readLog(n);
  }
  async function openNotes(search) {
    const wave = new URLSearchParams(search).has('wave');
    const n = show('notes', '');
    let html;
    try {
      const r = await fetch(B.site.url(`api/notes${search}`), { cache: 'no-store' });
      const answer = await r.json();
      if (!r.ok) throw new Error(answer.error || `notes ${r.status}`);
      if (n !== opened) return;
      sheet.querySelector('.reader-ref').textContent = `${wave ? answer.title : answer.ref} notes`;
      html = `<article class="plan reader-md">${markdown(answer.markdown, linkContext(state.board?.items || [], answer.key ?? null))}</article>`;
    } catch (e) { html = `<p class="muted">Could not load these notes: ${esc(e.message)}</p>`; }
    if (n === opened) body.innerHTML = html;
  }
  function close() {
    if (!sheet.open) return;
    sheet.close();
    opened++;
    stopReading?.();
    if (pushed) { pushed = false; history.back(); }
  }

  const plainTap = (ev) => !ev.defaultPrevented && ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
  B.on(B.root, 'click', (ev) => {
    if (!plainTap(ev)) return;
    const a = ev.target.closest('a[href^="log.html?"], a[href^="notes.html?"]');
    if (!a) return;
    ev.preventDefault();
    const href = a.getAttribute('href');
    if (href.startsWith('log.html')) openLog(new URLSearchParams(href.slice(href.indexOf('?'))).get('file'));
    else openNotes(href.slice(href.indexOf('?')));
  });
  B.on(sheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, sheet)) { close(); return; }
    const act = ev.target.closest('[data-reader]')?.dataset.reader;
    if (act === 'close') close();
    else if (act === 'raw') { log.raw = !log.raw; log.text = null; drawLog(); follow(); if (log.raw) readRaw(opened); }
    else if (act === 'end') follow();
    const call = ev.target.closest('[data-call]');
    if (call) {
      const i = Number(call.dataset.call);
      if (!log.opened.delete(i)) log.opened.add(i);
      drawLog();
    }
    const a = ev.target.closest('a[href]');
    if (!a || !plainTap(ev) || (a.target && a.target !== '_self')) return;
    ev.preventDefault();
    pending = new URL(a.getAttribute('href'), location.href).href;
    close();
  });
  B.on(sheet, 'cancel', (ev) => { ev.preventDefault(); close(); });
  B.on(body, 'scroll', () => {
    if (!log?.stream) return;
    log.following = atEnd();
    if (log.following) log.unseen = 0;
    drawTools();
    drawMore();
  });
  // Back while it's open: the router has kept the board, as the entry under it holds the same URL.
  B.on(window, 'popstate', () => {
    if (pushed) { pushed = false; sheet.close(); opened++; stopReading?.(); }
    if (!pending) return;
    const href = pending;
    pending = null;
    if (!AppShell.open(href)) location.assign(href);
  });
});
