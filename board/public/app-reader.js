// The reader sheet (docs/adr/2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md): a thread's "View transcript"
// (ui-threads.js) and a card's or a wave's Notes (app-cards.js, app-lanes.js) open over the board in one sheet in
// place of log.html and notes.html, which still open on their own. It closes on its ✕, Escape, a tap on the dim area
// (from 900px it is not modal: no dim area, and the left pane stays live). It makes no history entry.
// A link in it to a card page, a transcript or notes opens over what it shows, a page of its own (ui.js pushPage) with its
// layer: its ✕, Escape, a swipe and a tap on the dim area show the page beneath again as it was, and
// only the last closes the sheet. A question of the board opens the questions sheet stacked on it; any other link
// closes it first, then opens through the shell.
// A log written as a stream (headless.mjs: one stream-json event per line) reads as the run's transcript, the whole of
// it as GET /api/transcript's rows: what Claude says, and each tool call as one line whose output opens on a tap, with a
// raw toggle for the file as it is (docs/adr/2026-11-07-1224-view-transcript-reads-the-whole-run-as-rows.md); any other
// log reads as its text. Every 3 seconds until the run's result arrives it reads on from where it left off, and follows
// new lines while read at its end.
// docs/adr/2026-11-16-0514-prototypes-and-visuals-open-in-the-reader-sheet.md: a card page, a prototype round's page or a
// visual (router.js isCardPage), opens here too (openPage), whatever way it was reached: its body the page in a frame,
// its header the kind, the card's ref and the page's title, the card's Round pill for a prototype, and Open alone ↗.
// From 900px the sheet widens for a page (.reader-page); on a phone it is the modal sheet near full height. A link in
// the page to another card page of this board opens over it, as any link in the sheet does.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc, markdown, linkContext } = BoardUI;
  const sheet = $('#readerSheet');
  let body = sheet.querySelector('.reader-body');
  const tools = sheet.querySelector('.reader-tools');
  const more = sheet.querySelector('.reader-new');
  let opened = 0;
  let modal = true;
  let log = null;
  let stopReading = null;
  // The card whose notes the sheet shows, else null.
  let notesKey = null;
  // Whether the open sheet's notes follow the opened card (followCardNotes), as opposed to a view the owner opened.
  let autoNotes = false;
  // The card page the sheet shows, {url, q, rounds, title}, rounds whether the Round sheet is out, else null.
  let page = null;
  // The pages under the one shown, bottom first, each {body, log, notesKey, page, title, ref, scroll}: its body kept,
  // hidden, so a framed page keeps running where it was.
  const under = [];

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
    if (!log.finished) stopReading = B.later(3000, () => readLog(n)); // poll: run-log
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

  // What the sheet shows, kept under a fresh body for the page opening over it.
  function stackView() {
    under.push({ body, log, notesKey, page, title: sheet.querySelector('#readerTitle').textContent, ref: sheet.querySelector('.reader-ref').textContent, scroll: body.scrollTop });
    sheet.querySelector('.ps-sheet')?.remove();
    body.hidden = true;
    body.insertAdjacentHTML('beforebegin', '<div class="reader-body" tabindex="0"></div>');
    body = body.previousElementSibling;
    B.on(body, 'scroll', scrolled);
  }
  // The page beneath, shown again as it was; a transcript reads on.
  function unstackView() {
    const view = under.pop();
    opened++;
    stopReading?.();
    body.remove();
    sheet.querySelector('.ps-sheet')?.remove();
    ({ body, log, notesKey, page } = view);
    body.hidden = false;
    body.scrollTop = view.scroll;
    sheet.querySelector('#readerTitle').textContent = view.title;
    sheet.querySelector('.reader-ref').textContent = view.ref;
    sheet.classList.toggle('reader-page', Boolean(page));
    drawTools();
    drawMore();
    if (page) paintPage();
    if (log && !log.finished) readLog(opened);
  }
  function dropUnder() {
    for (const view of under.splice(0)) view.body.remove();
  }
  // Opened while the sheet is open, the page opens over the one it shows.
  function show(title, ref) {
    BoardUI.cutClose(sheet);
    const over = sheet.open;
    opened++;
    stopReading?.();
    if (over) stackView(); else dropUnder();
    log = null;
    notesKey = null;
    autoNotes = false;
    page = null;
    sheet.classList.remove('reader-page');
    sheet.querySelector('#readerTitle').textContent = title;
    sheet.querySelector('.reader-ref').textContent = ref;
    tools.innerHTML = '';
    more.hidden = true;
    body.innerHTML = '<p class="muted">Loading…</p>';
    if (!sheet.open) modal = !matchMedia('(min-width: 900px)').matches;
    // Opened from another sheet it stacks on it; a page over the first stacks on the sheet.
    if (over) BoardUI.pushPage(sheet); else BoardUI.openSheet(sheet, { modal });
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
  // search: ?item=<key>. auto: the notes follow the opened card, and followCardNotes may swap them in place; otherwise the
  // owner opened them, and they stay.
  async function openNotes(search, { auto = false } = {}) {
    const key = new URLSearchParams(search).get('item');
    const shown = sheet.open && !sheet.classList.contains('closing');
    if (shown && notesKey === key) { if (!auto) autoNotes = false; return; }
    let n;
    if (auto && shown && autoNotes && !under.length) {
      n = ++opened;
      notesKey = key;
      body.innerHTML = '<p class="muted">Loading…</p>';
    } else {
      n = show('notes', '');
      notesKey = key;
      autoNotes = auto;
    }
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
  // From 900px, a card the owner opens opens its notes while no view is open or the open one is notes that followed; a
  // card with open questions (asked) or no notes closes followed notes.
  function followCardNotes(key, asked) {
    if (!matchMedia('(min-width: 900px)').matches) return;
    const shown = sheet.open && !sheet.classList.contains('closing');
    if (shown && !autoNotes) return;
    if (asked || !state.board?.items.find((i) => i.key === key)?.hasNotes) { if (shown) closeAll(); return; }
    openNotes(`?item=${encodeURIComponent(key)}`, { auto: true });
  }
  // A card the owner collapses closes its notes if they opened by themselves.
  function leaveCardNotes(key) {
    if (sheet.open && autoNotes && notesKey === key) closeAll();
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
    const shown = { url, q: new URL(url).searchParams.get('q'), rounds: false, title: '' };
    page = shown;
    sheet.classList.add('reader-page');
    body.innerHTML = `<iframe class="reader-frame" src="${esc(url)}" title="Card page"></iframe>`;
    const frame = body.querySelector('iframe.reader-frame');
    B.on(frame, 'load', () => framedPage(frame, shown));
    paintPage();
    return true;
  }
  // Each load of the page: its title in the header, and its links' taps here. A page of another origin is its own, but
  // for a preview of the site's own, in an opaque origin, which sends both (preview-frame.js, previewMessage below).
  function framedPage(frame, shown) {
    let win;
    try { win = frame.contentWindow; if (!win || win.location.href === 'about:blank') return; } catch { return; }
    shown.title = win.document.title || '';
    if (page === shown) paintPage();
    B.on(win.document, 'click', (ev) => {
      if (!plainTap(ev)) return;
      const a = ev.target.closest?.('a[href]');
      if (!a || a.hasAttribute('download') || !['', '_self', '_top', '_parent'].includes(a.target)) return;
      const to = new URL(a.href, win.location.href);
      if (!AppRouter.viewOf(to.href, { boards: here }) || (to.pathname === win.location.pathname && to.search === win.location.search && to.hash)) return;
      ev.preventDefault();
      takeLink(to.href);
    });
  }
  // docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md: a message from the page shown, whatever its
  // origin, since a preview's is opaque. Its title goes in the header; a link it was tapped on opens as framedPage's
  // would, a board page here and any other web page in the frame. A page can send a link it wasn't tapped on, which
  // opens no more than a view of the board.
  function previewMessage(ev) {
    const frame = body.querySelector('iframe.reader-frame');
    if (!page || !frame || ev.source !== frame.contentWindow) return;
    if (ev.data?.kickflip === 'page') { page.title = String(ev.data.title ?? ''); paintPage(); return; }
    if (ev.data?.kickflip !== 'page-link') return;
    let to;
    try { to = new URL(String(ev.data.href)); } catch { return; }
    if (!['http:', 'https:'].includes(to.protocol)) return;
    if (AppRouter.viewOf(to.href, { boards: here })) takeLink(to.href);
    else frame.src = to.href;
  }
  B.on(window, 'message', previewMessage);
  // Closes the sheet with every page in it, then opens href through the shell. A question
  // the questions sheet under it shows (a prototype's Choose this) is already open there: the page closes, and that is all.
  function leave(href) {
    const to = new URL(href, location.href).href;
    const view = AppRouter.viewOf(to, { boards: here });
    const shows = view?.kind === 'questions' && view.id && B.questionsSheetShows?.(state.board?.owner.find((q) => q.id === view.id)?.topic ?? view.id);
    if (shows) { close(); return; }
    closeAll();
    if (!AppShell.open(to)) location.assign(to);
  }
  // A link tapped in the sheet: a card page, a transcript or notes opens over the page shown; a question of this board
  // opens the questions sheet stacked on this one (ui.js openSheet), which closing returns to; any other link leaves.
  function takeLink(href) {
    if (isCardPage(href)) { openPage(href); return; }
    const view = AppRouter.viewOf(href, { boards: here });
    const file = new URL(href).searchParams.get('file');
    if (view?.kind === 'frame' && here.has(view.route) && view.url.startsWith(`/${encodeURIComponent(view.route)}/log.html?`) && file) { openLog(file); return; }
    if (view?.kind === 'notes' && here.has(view.route) && view.item) { openNotes(`?item=${encodeURIComponent(view.item)}`); return; }
    if (view?.kind === 'questions' && view.id && B.openQuestionsSheet?.(view.id)) return;
    leave(href);
  }
  // The pages' frames go once the sheet has closed, so nothing runs in them unseen.
  function dropPage() {
    dropUnder();
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
  // ✕, Escape, a swipe, a tap on the dim area: back to the page beneath, and with none the sheet closes.
  function close() {
    if (!sheet.open) return;
    if (under.length) { unstackView(); BoardUI.popPage(sheet); return; }
    closeAll();
  }
  // The sheet closes with every page in it.
  function closeAll() {
    if (!sheet.open) return;
    BoardUI.closeSheet(sheet, B.later, () => { autoNotes = false; dropPage(); });
    opened++;
    stopReading?.();
  }

  Object.assign(B, { closeReader: closeAll, takeNotes, fillNotes, openPage, followCardNotes, leaveCardNotes });

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
    takeLink(href);
  });
  // A prototype's Choose this, or its push sending a picked question on to its card's thread (prototype-switcher.js
  // replaceWith), leaves through the sheet.
  B.on(sheet, 'reader-leave', (ev) => leave(ev.detail));
  // A non-modal sheet (from 900px) gets no cancel event from Escape, so the page's own key closes it.
  B.on(document, 'keydown', (ev) => { if (ev.key === 'Escape' && sheet.open && !modal && BoardUI.isTopSheet(sheet)) close(); });
  B.atUnmount(BoardUI.swipeToDismiss(sheet));
  // The view going takes its sheet out of the sheet stack (ui.js openSheet).
  B.atUnmount(() => sheet.close());
  B.on(sheet, 'cancel', (ev) => { ev.preventDefault(); close(); });
  function scrolled() {
    if (!log?.stream) return;
    log.following = atEnd();
    if (log.following) log.unseen = 0;
    drawTools();
    drawMore();
  }
  B.on(body, 'scroll', scrolled);
});
