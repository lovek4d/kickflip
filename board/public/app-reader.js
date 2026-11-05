// The reader sheet (docs/adr/2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md): a thread's "Open the log"
// (ui-threads.js) and a card's or a lineup's Notes (app-cards.js, app-lanes.js) open over the board in one sheet in
// place of log.html and notes.html, which still open on their own. It closes on its ✕, Escape, a tap on the dim area
// and Back, through a history entry of its own that carries the board's URL, so the router's pop keeps the board.
// A link in it closes it first, then opens through the shell.
// A log written as a stream (headless.mjs: one stream-json event per line) reads as lines, what Claude says and each
// tool call, with a raw toggle for the file as it is; any other log reads as its text. It is re-read every 3 seconds
// until the run's result arrives, and follows new lines while read at its end.
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

  // → the log's lines, each a stream event or, for a line that isn't one, its text; null when no line is an event.
  function streamOf(text) {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const read = (line) => { try { const e = JSON.parse(line); return typeof e?.type === 'string' ? e : null; } catch { return null; } };
    const events = lines.map(read);
    return events.some(Boolean) ? lines.map((line, i) => events[i] ?? line) : null;
  }
  const short = (v) => (v.length > 400 ? `${v.slice(0, 400)}…` : v);
  const textOf = (content) => (typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('\n'));
  const callOf = (input) => input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? JSON.stringify(input);
  // A stream line's readable rows {kind, label, body}. Thinking and events other than the start, messages and the
  // result have none; the raw view shows them.
  function rowsOf(e) {
    if (typeof e === 'string') return [{ kind: 'out', body: e }];
    if (e.type === 'system') return e.subtype === 'init' ? [{ kind: 'sys', label: 'start', body: `${e.model} in ${e.cwd}` }] : [];
    if (e.type === 'result') return [{ kind: 'text end', label: e.is_error ? 'stopped' : 'done', body: e.result ?? e.subtype }];
    if (e.type !== 'assistant' && e.type !== 'user') return [];
    const content = e.message.content;
    if (typeof content === 'string') return [{ kind: 'text', body: content }];
    return content.flatMap((c) => (c.type === 'text' ? [{ kind: 'text', body: c.text }]
      : c.type === 'tool_use' ? [{ kind: 'tool', label: c.name.toLowerCase(), body: callOf(c.input) }]
      : c.type === 'tool_result' ? [{ kind: 'out', body: short(textOf(c.content)) }] : []));
  }
  const rowHtml = (r) => `<div class="reader-row ${r.kind}">${r.label ? `<span class="reader-tag">${esc(r.label)}</span>` : ''}${esc(r.body)}</div>`;

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
    const { text, stream, raw } = log;
    body.innerHTML = !text ? '<p class="muted reader-empty">The log is empty so far.</p>'
      : !stream ? `<pre class="reader-text">${esc(text)}</pre>`
      : raw ? `<pre class="reader-raw">${esc(text)}</pre>`
      : stream.flatMap(rowsOf).map(rowHtml).join('');
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

  async function readLog(n) {
    let answer;
    try {
      const r = await fetch(B.site.url(`api/log?file=${encodeURIComponent(log.file)}`), { cache: 'no-store' });
      answer = { ok: r.ok, ...(await r.json()) };
    } catch { answer = null; }
    if (n !== opened) return;
    if (answer && !answer.ok) { body.innerHTML = `<p class="muted">${esc(answer.error || 'Could not load this log.')}</p>`; return; }
    if (answer && answer.size !== log.size) {
      const before = log.stream?.length ?? 0;
      const stream = streamOf(answer.text);
      Object.assign(log, { size: answer.size, text: answer.text, stream, finished: Boolean(stream?.some((e) => e.type === 'result')) });
      if (!log.following) log.unseen += Math.max(0, (stream?.length ?? 0) - before);
      drawLog();
      if (log.following) toEnd();
    }
    if (!log.finished) stopReading = B.later(3000, () => readLog(n));
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
    const n = show(`${file.split('-')[0]} log`, file);
    log = { file, size: -1, text: '', stream: null, raw: false, following: true, unseen: 0, finished: false };
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
    if (ev.target === sheet) { close(); return; }
    const act = ev.target.closest('[data-reader]')?.dataset.reader;
    if (act === 'close') close();
    else if (act === 'raw') { log.raw = !log.raw; drawLog(); follow(); }
    else if (act === 'end') follow();
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
