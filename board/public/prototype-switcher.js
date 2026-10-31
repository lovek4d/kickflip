// The floating ‹ take › pill every prototype page switches its takes with (docs/adr/0015-prototypes-come-on-request.md).
// Load it with a relative src after claude.js, on a page whose header leads with the back arrow, then call
//   const sw = PrototypeSwitcher.mount({ takes: { A: 'A. Name', … }, initial: 'A', render(take) {…}, above: el? })
// render runs at mount and on each switch; sw.take is the current key. ←/→ switch unless a field has focus, and the
// take stays in ?variant=. With ?q=<owner question id>, the pill offers the take as that question's answer: a take
// is pickable when an option's id equals its key. Pick sends the owner-answer event questions.html sends, with the
// note typed above the pill, then moves on through BoardUI.nextQuestion (ui-questions.js).
// With ?take=<key> the page shows that take alone, with no header or pill, as questions.html frames it
// (docs/adr/0048-a-questions-takes-show-inline.md); a page hides its own extras under html.ps-embed. There main's
// bottom padding, kept clear for the pill, shrinks to 12px whatever the page sets, since questions.html sizes the frame
// to the page's height.
(function () {
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const takeAt = (keys, current, step) => {
    const n = keys.length;
    return keys[((Math.max(0, keys.indexOf(current)) + step) % n + n) % n];
  };
  const startTake = (keys, wanted, initial) => (keys.includes(wanted) ? wanted : keys.includes(initial) ? initial : keys[0]);

  // The owner's current pick is the latest answer that chose an option; a note-only answer keeps the earlier pick.
  const pickedChoice = (question) => [...(question?.answers || [])].reverse().find((a) => a.choice)?.choice ?? null;
  // none: no question, or the take is not one of its options. pick: nothing picked yet. picked: this take is the
  // owner's pick. change: another take is.
  function pickState(question, take) {
    if (!question) return { kind: 'none' };
    const option = (question.options || []).find((o) => o.id === take);
    const picked = pickedChoice(question);
    if (!option) return { kind: 'none', picked };
    if (!picked) return { kind: 'pick', option };
    return { kind: picked === take ? 'picked' : 'change', option, picked };
  }
  // Matches ui-questions.js choiceLabel for a single-choice question.
  const answerLabel = (option) => `${/^[A-Z][0-9]?$/i.test(option.id) ? `${option.id}. ` : ''}${option.label}`;
  const questionUrl = (q) => (/^prototype-[\w-]+\.html(?:[?#]|$)/.test(q.url || '') ? q.url : `questions.html#${encodeURIComponent(q.id)}`);
  // questions.html keeps each question's unsent {choice, note} under this key; a pick sent here takes its note and clears it.
  const draftKey = (qid) => 'qdraft:' + qid;
  const readDraft = (qid) => { try { return JSON.parse(localStorage.getItem(draftKey(qid)) || '{}'); } catch { return {}; } };
  // In place of this page: framed in the app shell, the shell shows the URL's view in place (board/public/shell.js
  // AppShell.open); alone, or for a URL that isn't a view, the page loads it.
  function replaceWith(url) {
    let app = null;
    try { app = window.top !== window ? window.top.AppShell : null; } catch { app = null; }
    if (!app?.open?.(String(url), { replace: true })) location.replace(url);
  }

  // Prototype pages need only claude.js and this switcher. In the shell, its BoardUI also owns the board's notice.
  let questionsUI = null;
  const sharedQuestions = (site) => (questionsUI ||= (async () => {
    try { if (window.top !== window && window.top.BoardUI?.nextQuestion) return window.top.BoardUI; } catch {}
    for (const [file, key] of [['ui.js', 'esc'], ['ui-links.js', 'linkText'], ['ui-questions.js', 'nextQuestion']]) {
      if (globalThis.BoardUI?.[key]) continue;
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = site.url(file);
        script.onload = resolve;
        script.onerror = reject;
        document.head.append(script);
      });
    }
    return globalThis.BoardUI;
  })().catch((e) => { questionsUI = null; throw e; }));

  function pillHtml({ name, pick = { kind: 'none' }, busy = false }) {
    const control = pick.kind === 'picked' ? '<span class="ps-picked">Picked</span>'
      : pick.kind === 'pick' || pick.kind === 'change'
        ? `<button type="button" class="ps-pick" data-ps="pick"${busy ? ' disabled' : ''}>${busy ? 'Sending…' : pick.kind === 'pick' ? 'Pick this' : 'Change pick'}</button>`
        : '';
    return `<button type="button" data-ps="prev" aria-label="Previous take">‹</button><span class="ps-name" title="${esc(name)}">${esc(name)}</span><button type="button" data-ps="next" aria-label="Next take">›</button>${control}`;
  }

  const CSS = `
.ps-switch { position:fixed; left:16px; right:16px; bottom:calc(14px + env(safe-area-inset-bottom)); z-index:30;
  display:flex; flex-direction:column; align-items:center; gap:6px; pointer-events:none; }
.ps-switch > * { pointer-events:auto; max-width:100%; min-width:0; box-sizing:border-box; }
.ps-switch .pill, .ps-pill { display:flex; align-items:center; gap:2px; background:#000d; border:1px solid #fff3; border-radius:999px; padding:4px;
  -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); font:600 13px -apple-system, system-ui, sans-serif; }
.ps-switch .pill button, .ps-pill button { color:#fff; background:transparent; border:0; border-radius:999px; padding:7px 11px; font:inherit; white-space:nowrap; cursor:pointer; }
.ps-pill button { flex-shrink:0; min-width:44px; min-height:44px; }
.ps-switch .pill button.on { background:#fff; color:#000; }
.ps-name { flex:0 1 auto; padding:7px 6px; color:#fff; white-space:nowrap; min-width:0; text-align:center; overflow:hidden; text-overflow:ellipsis; }
.ps-pill .ps-pick { background:#fff; color:#000; margin-left:2px; }
.ps-pill .ps-pick:disabled { opacity:.6; cursor:default; }
.ps-switch .ps-text { width:min(420px, 100%); resize:none; border-radius:12px; border:1px solid #fff3; background:#000d; color:#fff;
  padding:7px 10px; font:400 14px -apple-system, system-ui, sans-serif; -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); }
.ps-switch .ps-text::placeholder { color:#fffa; }
.ps-switch .ps-text[hidden] { display:none; }
.ps-picked { margin-left:2px; padding:7px 11px; border-radius:999px; color:#fff; background:#1f9d55; white-space:nowrap; }
.ps-note { background:#000d; color:#fff; border-radius:8px; padding:5px 10px; font:500 12px -apple-system, system-ui, sans-serif; text-align:center; }
.ps-note[hidden] { display:none; }
.ps-embed header.top { display:none; }
.ps-embed main { padding-bottom:12px !important; }`;

  const typing = (el) => Boolean(el?.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"])'));

  function mount({ takes, initial, render, above = null }) {
    const keys = Object.keys(takes);
    const params = new URLSearchParams(location.search);
    const qid = params.get('q');
    const site = globalThis.ClaudeSite;
    if (!document.getElementById('ps-style')) document.head.insertAdjacentHTML('beforeend', `<style id="ps-style">${CSS}</style>`);
    if (params.has('take')) {
      const only = startTake(keys, params.get('take'), initial);
      document.documentElement.classList.add('ps-embed');
      render(only);
      return { take: only, go() {} };
    }
    let take = startTake(keys, params.get('variant'), initial);
    let question = null;
    let topics = [];
    // A push opened this page (board/store.mjs pushUrl). Read once and dropped from the URL, so a pick made here or a
    // reload stays on the page; only the first load sends an already-picked question on to its card's thread.
    let fromPush = params.get('from') === 'push';
    if (fromPush) { const u = new URL(location.href); u.searchParams.delete('from'); history.replaceState(null, '', u); }

    const box = document.createElement('div');
    box.className = 'ps-switch';
    box.innerHTML = '<div class="ps-note" role="status" hidden></div><textarea class="ps-text" rows="2" placeholder="Note with your pick (optional)" aria-label="Note with your pick" hidden></textarea><div class="ps-pill"></div>';
    if (above) box.prepend(above);
    document.body.append(box);
    const pill = box.querySelector('.ps-pill');
    const noteEl = box.querySelector('.ps-note');
    const text = box.querySelector('.ps-text');
    let busy = false;

    const note = (text) => { noteEl.textContent = text || ''; noteEl.hidden = !text; };
    function paint() {
      const state = pickState(question, take);
      pill.innerHTML = pillHtml({ name: takes[take], pick: state, busy });
      text.hidden = !(state.kind === 'pick' || state.kind === 'change');
    }
    function go(next) {
      take = next;
      const u = new URL(location.href); u.searchParams.set('variant', take); history.replaceState(null, '', u);
      note('');
      paint();
      render(take);
    }

    async function load() {
      if (!qid || !site) return;
      let board = null;
      try {
        board = await (await fetch(site.url('api/board'), { cache: 'no-store' })).json();
        question = (board.owner || []).find((q) => q.id === qid) || null;
        topics = board.ownerTopics || [];
        if (!question) note('This prototype’s question is gone, so there is nothing to pick.');
      } catch { /* keep the last question shown */ }
      if (fromPush && pickedChoice(question)) {
        const card = /^item:(.+)$/.exec(question.topic || '')?.[1];
        replaceWith(site.url(card ? `#item=${encodeURIComponent(card)}&reply` : 'questions.html'));
        return;
      }
      if (question && !text.value) text.value = readDraft(qid).note || '';
      fromPush = false;
      paint();
      return board;
    }

    async function pick() {
      const state = pickState(question, take);
      if (busy || !(state.kind === 'pick' || state.kind === 'change')) return;
      busy = true; paint();
      const answered = question;
      let ui, pills, name;
      try {
        ui = await sharedQuestions(site);
        pills = ui.topicRow(topics, answered.topic).pills;
        const topic = topics.find((t) => t.id === answered.topic);
        name = topic ? ui.topicName(topic) : '';
        await site.send('owner-answer', { id: answered.id, question: answered.question, choice: state.option.id, label: answerLabel(state.option), note: text.value.trim() });
      } catch { busy = false; paint(); note('Could not send. Is the Mac awake?'); return; }
      try { localStorage.removeItem(draftKey(qid)); } catch { /* nothing kept */ }
      text.value = '';
      busy = false;
      note('Sent. Claude replies on the card.');
      const board = await load();
      const next = ui.nextQuestion(board?.owner || [], pills, answered);
      if (next) {
        const u = new URL(site.url(questionUrl(next)), location.href);
        if (globalThis.PageBack?.pushed) u.searchParams.set('from', 'push');
        replaceWith(u);
      } else {
        const route = new URL(site.url(''), location.href).pathname.replace(/^\/+|\/+$/g, '');
        ui.sentNotice.put(route, `Sent 1 answer${name ? ` to ${name}` : ''}.`);
        replaceWith(site.url('./'));
      }
    }
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      pick();
    });

    pill.addEventListener('click', (e) => {
      const act = e.target.closest('[data-ps]')?.dataset.ps;
      if (act === 'prev') go(takeAt(keys, take, -1));
      else if (act === 'next') go(takeAt(keys, take, 1));
      else if (act === 'pick') pick();
    });
    document.addEventListener('keydown', (e) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') go(takeAt(keys, take, -1));
      else if (e.key === 'ArrowRight') go(takeAt(keys, take, 1));
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

    go(take);
    load();
    return { get take() { return take; }, go };
  }

  globalThis.PrototypeSwitcher = { takeAt, startTake, pickedChoice, pickState, answerLabel, pillHtml, mount };
})();
