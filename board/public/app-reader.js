// The reader sheet (docs/adr/2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md): a thread's "View transcript"
// (ui-threads.js) and a card's or a wave's Notes (app-cards.js, app-lanes.js) open over the board in one sheet in
// place of log.html and notes.html, which still open on their own. It closes on its ✕, Escape, a tap on the dim area
// and Back (from 900px it is not modal: no dim area, and the left pane stays live), through a history entry of its own that carries the board's URL, so the router's pop keeps the board.
// A link in it closes it first, then opens through the shell.
// A log written as a stream (headless.mjs: one stream-json event per line) reads as the run's transcript, the whole of
// it as GET /api/transcript's rows: what Claude says, and each tool call as one line whose output opens on a tap, with a
// raw toggle for the file as it is (docs/adr/2026-11-07-1224-view-transcript-reads-the-whole-run-as-rows.md); any other
// log reads as its text. Every 3 seconds until the run's result arrives it reads on from where it left off, and follows
// new lines while read at its end.
// docs/adr/2026-11-16-0514-prototypes-and-visuals-open-in-the-reader-sheet.md: a card page, a prototype round's page or a
// visual (router.js isCardPage), opens here too (openPage), whatever way it was reached: its body the page in a frame,
// its header the kind, the card's ref and the page's title, the card's Round pill for a prototype, and Open alone ↗.
// From 900px the sheet widens for a page (.reader-page); on a phone it is the modal sheet near full height. A link in
// the page to another card page of this board opens in its place; one to any other view closes the sheet first.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc, markdown, linkContext } = BoardUI;
  const sheet = $('#readerSheet');
  const body = sheet.querySelector('.reader-body');
  const tools = sheet.querySelector('.reader-tools');
  const more = sheet.querySelector('.reader-new');
  let opened = 0;
  let pushed = false;
  let modal = true;
  let pending = null;
  let log = null;
  let stopReading = null;
  // The card whose notes the sheet shows, else null.
  let notesKey = null;
  // The card page the sheet shows, {url, q, rounds}, rounds whether the Round sheet is out, else null.
  let page = null;

  // A row of the transcript (transcript.mjs); a call with its output opens it on a tap of its line. What Claude says,
  // its text rows and its result, is markdown in compact styles, linking the board's refs
  // (docs/adr/2026-11-09-1453-orchestrator-messages-replies-and-transcript-text-are-markdown.md).
  function rowHtml(r, i, links) {
    const tag = r.label ? `<span class="reader-tag">${esc(r.label)}</span>` : '';
    if (r.kind.split(' ')[0] === 'text') return `<div class="reader-row ${r.kind} md">${tag}${markdown(r.body, links)}</div>`;
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
    const links = linkContext(state.board?.items || [], null);
    body.innerHTML = !rows.length ? '<p class="muted reader-empty">The log is empty so far.</p>'
      : !stream ? `<pre class="reader-text">${esc(rows.map((r) => `${r.body}\n`).join(''))}</pre>`
      : raw ? (text === null ? '<p class="muted">Loading…</p>' : `<pre class="reader-raw">${esc(text)}</pre>`)
      : rows.map((r, i) => rowHtml(r, i, links)).join('');
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
    BoardUI.cutClose(sheet);
    opened++;
    stopReading?.();
    log = null;
    notesKey = null;
    page = null;
    sheet.classList.remove('reader-page');
    sheet.querySelector('#readerTitle').textContent = title;
    sheet.querySelector('.reader-ref').textContent = ref;
    tools.innerHTML = '';
    more.hidden = true;
    body.innerHTML = '<p class="muted">Loading…</p>';
    if (!sheet.open) {
      modal = !matchMedia('(min-width: 900px)').matches;
      BoardUI.openSheet(sheet, { modal });
    }
    // One entry for the open sheet, whatever it shows next, so Back and a close take it back once.
    if (!pushed) {
      history.pushState({ ...history.state, idx: history.state.idx + 1, reader: true }, '', location.href);
      pushed = true;
    }
    return opened;
  }
  function openLog(file) {
    const n = show(`${file.split('-')[0]} transcript`, file);
    log = { file, read: false, next: 0, rows: [], calls: new Map(), opened: new Set(), stream: false, finished: false, raw: false, text: null, following: true, unseen: 0 };
    readLog(n);
  }
  // docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md: a card's notes draw from state.notesCache, which the board's
  // sync keeps, at once and again whenever it brings them changed; a card the cache lacks (a Done page loaded later, a
  // first load still filling) loads its own.
  function paintNotes(key, md, ref) {
    sheet.querySelector('.reader-ref').textContent = `${ref} notes`;
    body.innerHTML = `<article class="plan reader-md">${markdown(md, linkContext(state.board?.items || [], key))}</article>`;
  }
  const refOf = (key) => state.board?.items.find((i) => i.key === key)?.ref ?? key;
  async function openNotes(search) {
    const key = new URLSearchParams(search).get('item');
    if (sheet.open && !sheet.classList.contains('closing') && notesKey === key) return;
    const n = show('notes', '');
    notesKey = key;
    if (state.notesCache.has(key)) { paintNotes(key, state.notesCache.get(key), refOf(key)); return; }
    let answer;
    try {
      const r = await fetch(B.site.url(`api/notes${search}`), { cache: 'no-store' });
      answer = await r.json();
      if (!r.ok) throw new Error(answer.error || `notes ${r.status}`);
    } catch (e) {
      if (n === opened) body.innerHTML = `<p class="muted">Could not load these notes: ${esc(e.message)}</p>`;
      return;
    }
    if (n === opened) paintNotes(answer.key ?? key, answer.markdown, answer.ref);
  }
  // The open sheet's notes again, when the cache holds them changed.
  function repaintNotes(keys) {
    if (sheet.open && notesKey !== null && keys.includes(notesKey) && state.notesCache.has(notesKey)) paintNotes(notesKey, state.notesCache.get(notesKey), refOf(notesKey));
  }

  // A card page: the board's route, whose card pages open here (router.js isCardPage); the card a page belongs to, a
  // prototype's by its question's round or topic, a visual's by the card id in its path (board/store.mjs addVisual).
  const here = new Set([decodeURIComponent(new URL(B.site.url(''), location.href).pathname.split('/')[1])]);
  const isCardPage = (href) => AppRouter.isCardPage(AppRouter.viewOf(href, { boards: here }), here);
  function cardOfPage(url) {
    const items = state.board?.items || [];
    const visual = /\/visuals\/([\w-]+)\/[\w-]+\.html$/.exec(url.pathname)?.[1];
    if (visual) return items.find((i) => i.key.split('/').pop() === visual) || null;
    const q = url.searchParams.get('q');
    const topic = state.board?.owner.find((x) => x.id === q)?.topic;
    return items.find((i) => i.prototypes?.rounds?.some((r) => r.q === q) || `item:${i.key}` === topic) || null;
  }
  function paintPage(title = page.title) {
    page.title = title;
    const url = new URL(page.url);
    const card = cardOfPage(url);
    const rounds = card?.prototypes?.rounds;
    sheet.querySelector('#readerTitle').textContent = /\/visuals\//.test(url.pathname) ? 'visual' : 'prototype';
    sheet.querySelector('.reader-ref').textContent = [card?.ref, title].filter(Boolean).join(' · ');
    tools.innerHTML = `${BoardUI.roundPill(rounds, page.q)}<a class="reader-alone" href="${esc(BoardUI.aloneHref(page.url))}" target="_blank" rel="noopener">Open alone ${BoardUI.LINK_ARROW}</a>`;
    sheet.querySelector('.ps-sheet')?.remove();
    if (page.rounds && rounds) body.insertAdjacentHTML('beforebegin', BoardUI.roundSheet({ ref: card.ref, rounds, qid: page.q }));
  }
  // href: the page's URL. A page already open stays put. → true, the shell's sign that the board took it (shell.js go).
  function openPage(href) {
    const url = new URL(href, location.href).href;
    if (sheet.open && !sheet.classList.contains('closing') && page?.url === url) return true;
    show('', '');
    page = { url, q: new URL(url).searchParams.get('q'), rounds: false, title: '' };
    sheet.classList.add('reader-page');
    body.innerHTML = `<iframe class="reader-frame" src="${esc(url)}" title="Card page"></iframe>`;
    const frame = body.querySelector('iframe.reader-frame');
    B.on(frame, 'load', () => framedPage(frame));
    paintPage();
    return true;
  }
  // Each load of the page: its title in the header, and its links' taps here (a page of another origin is its own).
  function framedPage(frame) {
    let win;
    try { win = frame.contentWindow; if (!win || win.location.href === 'about:blank') return; } catch { return; }
    if (page?.url) paintPage(win.document.title || '');
    B.on(win.document, 'click', (ev) => {
      if (!plainTap(ev)) return;
      const a = ev.target.closest?.('a[href]');
      if (!a || a.hasAttribute('download') || !['', '_self', '_top', '_parent'].includes(a.target)) return;
      const to = new URL(a.href, win.location.href);
      if (!AppRouter.viewOf(to.href, { boards: here }) || (to.pathname === win.location.pathname && to.search === win.location.search && to.hash)) return;
      ev.preventDefault();
      if (isCardPage(to.href)) openPage(to.href); else leave(to.href);
    });
  }
  // Closes the sheet, then opens href through the shell (the popstate below).
  function leave(href) {
    pending = new URL(href, location.href).href;
    close();
  }
  // The page's frame goes once the sheet has closed, so nothing runs in it unseen.
  function dropPage() {
    if (!page) return;
    page = null;
    body.innerHTML = '';
    sheet.querySelector('.ps-sheet')?.remove();
    sheet.classList.remove('reader-page');
  }

  // A board patch's notes ({<key>: markdown, or null for none}) into the cache. Each fill running keeps the keys, so its
  // answer, which may be older, leaves them as the patch did.
  const fills = new Set();
  function takeNotes(notes) {
    const keys = Object.keys(notes);
    for (const key of keys) {
      if (notes[key] === null) state.notesCache.delete(key); else state.notesCache.set(key, notes[key]);
      for (const patched of fills) patched.add(key);
    }
    if (keys.length) repaintNotes(keys);
  }
  // After a whole board, which carries no notes, every card's load at once (GET /api/notes?all=1) in place of the cache's.
  async function fillNotes() {
    const patched = new Set();
    fills.add(patched);
    try {
      const r = await fetch(B.site.url('api/notes?all=1'), { cache: 'no-store' });
      if (!r.ok || !B.alive()) return;
      const { notes } = await r.json();
      for (const key of state.notesCache.keys()) if (!(key in notes) && !patched.has(key)) state.notesCache.delete(key);
      for (const [key, md] of Object.entries(notes)) if (!patched.has(key)) state.notesCache.set(key, md);
      repaintNotes(Object.keys(notes));
      B.saveCopySoon?.();
    } catch {} finally { fills.delete(patched); }
  }
  function close() {
    if (!sheet.open) return;
    BoardUI.closeSheet(sheet, B.later, dropPage);
    opened++;
    stopReading?.();
    if (pushed) { pushed = false; history.back(); }
  }

  Object.assign(B, { closeReader: close, takeNotes, fillNotes, openPage });

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
    // A prototype's Round pill opens its card's rounds, and a round opens in the pill's place.
    const round = ev.target.closest('[data-ps-round]')?.dataset.psRound;
    if (round) { openPage(B.site.url(round)); return; }
    if (page && ev.target.closest('[data-ps-top="rounds"]')) { page.rounds = !page.rounds; paintPage(); return; }
    const a = ev.target.closest('a[href]');
    if (!a || !plainTap(ev) || (a.target && a.target !== '_self')) return;
    ev.preventDefault();
    const href = new URL(a.getAttribute('href'), location.href).href;
    if (isCardPage(href)) openPage(href); else leave(href);
  });
  // A prototype's Choose this, or its push sending a picked question on to its card's thread (prototype-switcher.js
  // replaceWith), leaves through the sheet.
  B.on(sheet, 'reader-leave', (ev) => leave(ev.detail));
  // A non-modal sheet (from 900px) gets no cancel event from Escape, so the page's own key closes it.
  B.on(document, 'keydown', (ev) => { if (ev.key === 'Escape' && sheet.open && !modal) close(); });
  B.atUnmount(BoardUI.swipeToDismiss(sheet));
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
    if (pushed) { pushed = false; sheet.close(); opened++; stopReading?.(); dropPage(); }
    if (!pending) return;
    const href = pending;
    pending = null;
    if (!AppShell.open(href)) location.assign(href);
  });
});
