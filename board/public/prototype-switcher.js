// The full-bleed prototype viewer's controls (docs/adr/2026-10-29-1639-prototypes-come-on-request.md,
// docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md,
// docs/adr/2026-11-07-0300-prototypes-have-their-own-button-and-viewer.md,
// docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md).
// Load it with a relative src after claude.js, on a page whose header leads with the back arrow, then call
//   const sw = PrototypeSwitcher.mount({ takes: { A: 'A. Name', … }, states: { empty: 'No cards', … }?, initial: 'A', render(take, state) {…}, above: el? })
// render runs at mount and on each switch of take or state; sw.take is the current key. A served round's named states
// (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md) are a row of chips above the
// pager, the state kept in ?state=, else the first. The page's header is hidden: a ✕ at the top
// right goes back as its back arrow does, and the footer, full width on the bottom edge at every width, holds the
// ‹ take › pager. Framed in the board's right pane, the pane's top bar takes the ✕'s and the Round pill's place. ←/→
// and a sideways swipe switch unless a field has focus, and the take stays in ?variant=. With ?q=<owner question id>, the bar's second row offers
// the take as that question's pick: a take is pickable when an option's id equals its key. Choose this drafts it, with
// the note typed above the bar, in the {choice, note} questions.html keeps for that question, and goes back to the
// question, whose Send sends it. A card with more than one prototype round gets a Round pill at the top left, which
// opens a sheet of its rounds (/api/board's card prototypes.rounds, board/domain.mjs).
(function () {
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const takeAt = (keys, current, step) => {
    const n = keys.length;
    return keys[((Math.max(0, keys.indexOf(current)) + step) % n + n) % n];
  };
  const startTake = (keys, wanted, initial) => (keys.includes(wanted) ? wanted : keys.includes(initial) ? initial : keys[0]);

  // The owner's last sent pick is the latest answer that chose an option; a note-only answer keeps the earlier pick.
  const pickedChoice = (question) => [...(question?.answers || [])].reverse().find((a) => a.choice)?.choice ?? null;
  // The pick a question shows on Waiting on you (ui-questions.js choiceOf): drafted, this device's unsent pick, which Send
  // would send, else the last answer's, else the option the overnight triage suggested. A resolved question is locked at
  // its last answer, and one waiting on the prototype the owner asked for at the request's pick.
  const locked = (question) => question.state === 'resolved' || question.state === 'requested';
  const shownPick = (question, drafted) => question.state === 'requested' ? question.request?.choice ?? null
    : question.state === 'resolved' ? pickedChoice(question)
    : drafted ?? pickedChoice(question) ?? question.suggested?.option ?? null;
  // none: no question, the take is not one of its options, or the question waits on a requested prototype and the take
  // isn't its pick. closed: the question is resolved and the take isn't its pick. pick: nothing picked yet. picked: this
  // take is the pick. change: another take is.
  function pickState(question, take, drafted = null) {
    if (!question) return { kind: 'none' };
    const option = (question.options || []).find((o) => o.id === take);
    const picked = shownPick(question, drafted);
    if (!option) return { kind: 'none', picked };
    if (picked === take) return { kind: 'picked', option, picked };
    if (locked(question)) return { kind: question.state === 'resolved' ? 'closed' : 'none', picked };
    return picked ? { kind: 'change', option, picked } : { kind: 'pick', option };
  }
  // questions.html keeps each question's unsent {choice, note} under this key (ui-questions.js getDraft).
  const draftKey = (qid) => 'qdraft:' + qid;
  const readDraft = (qid) => { try { return JSON.parse(localStorage.getItem(draftKey(qid)) || '{}'); } catch { return {}; } };
  const writeDraft = (qid, draft) => { try { localStorage.setItem(draftKey(qid), JSON.stringify(draft)); } catch { /* nothing kept */ } };
  // In place of this page: framed in the app shell, the shell shows the URL's view in place, going up to the question
  // the viewer sits under (board/public/shell.js AppShell.open, router.js); alone, the page loads it.
  function replaceWith(url) {
    let app = null;
    try { app = window.top !== window ? window.top.AppShell : null; } catch { app = null; }
    if (!app?.open?.(String(url), { replace: true })) location.replace(url);
  }

  // The bar: the states' chips when the round has states, the ‹ name › pager, and below it on its own row the pick
  // control, when there is one.
  function pillHtml({ name, pick = { kind: 'none' }, states = null, state = null }) {
    const chips = states ? `<div class="ps-row ps-states">${Object.entries(states).map(([key, label]) => `<button type="button" data-ps-state="${esc(key)}" aria-pressed="${key === state}">${esc(label)}</button>`).join('')}</div>` : '';
    const control = pick.kind === 'picked' ? '<span class="ps-picked">Picked</span>'
      : pick.kind === 'closed' ? '<span class="ps-closed">Round answered</span>'
      : pick.kind === 'pick' || pick.kind === 'change' ? '<button type="button" class="ps-pick" data-ps="pick">Choose this</button>'
      : '';
    return `${chips}<div class="ps-row"><button type="button" data-ps="prev" aria-label="Previous take">‹</button><span class="ps-name" title="${esc(name)}">${esc(name)}</span><button type="button" data-ps="next" aria-label="Next take">›</button></div>${control ? `<div class="ps-row ps-act">${control}</div>` : ''}`;
  }

  // A touch from start to end: 1 for a swipe left (the next take), -1 for a swipe right, 0 for anything else: under
  // 50px sideways, more down than across, or starting at the left edge, where the drawer's and the browser's swipes are.
  const swipeStep = (start, end) => {
    const dx = end.x - start.x;
    return start.x < 24 || Math.abs(dx) < 50 || Math.abs(end.y - start.y) * 2 > Math.abs(dx) ? 0 : dx < 0 ? 1 : -1;
  };

  const CSS = `
body > header.top { display:none; }
/* style.css sets --app-bottom on a phone for the bar the header becomes; hidden here, it leaves nothing to clear. */
:root { --app-bottom:0px !important; }
main.proto-main { padding-top:calc(60px + env(safe-area-inset-top)); }
.ps-top { position:fixed; left:10px; right:10px; top:calc(10px + env(safe-area-inset-top)); z-index:31; display:flex; justify-content:space-between;
  align-items:flex-start; pointer-events:none; font:600 13px -apple-system, system-ui, sans-serif; }
.ps-top > * { pointer-events:auto; }
.ps-pending { visibility:hidden; }
.ps-chip, .ps-close { color:#fff; background:#000a; border:1px solid #fff4; -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); font:inherit; cursor:pointer; }
.ps-chip { border-radius:999px; padding:0 14px; min-height:40px; }
.ps-close { margin-left:auto; width:40px; height:40px; border-radius:50%; font-size:17px; line-height:1; }
.ps-sheet { position:fixed; left:0; right:0; bottom:0; z-index:32; padding:14px 16px calc(22px + env(safe-area-inset-bottom)); border-radius:18px 18px 0 0;
  background:#26262c; color:#fff; box-shadow:0 -8px 30px #0009; }
.ps-sheet h3 { margin:0 0 8px; font-size:14px; }
.ps-sheet button { display:flex; justify-content:space-between; gap:12px; width:100%; border:0; border-top:1px solid #fff2; background:transparent; color:#fff;
  padding:12px 2px; font:inherit; font-weight:500; text-align:left; cursor:pointer; }
.ps-sheet button span + span { opacity:.7; }
.ps-switch { position:fixed; left:0; right:0; bottom:var(--app-bottom, 0px); z-index:30; display:flex; flex-direction:column; align-items:stretch;
  background:#202026; border-top:1px solid #fff3; padding:6px 6px calc(6px + env(safe-area-inset-bottom)); box-sizing:border-box; }
.ps-switch > * { min-width:0; box-sizing:border-box; }
.ps-pill { display:flex; flex-direction:column; gap:6px; border-radius:0; font:600 13px -apple-system, system-ui, sans-serif; }
.ps-row { display:flex; align-items:center; gap:2px; min-width:0; }
.ps-pill button { color:#fff; background:transparent; border:0; border-radius:999px; padding:7px 11px; font:inherit; white-space:nowrap; cursor:pointer; }
.ps-pill button { flex-shrink:0; min-width:44px; min-height:44px; }
.ps-name { flex:1 1 auto; padding:7px 6px; color:#fff; white-space:nowrap; min-width:0; text-align:center; overflow:hidden; text-overflow:ellipsis; }
.ps-act > * { flex:1; text-align:center; }
.ps-states { overflow-x:auto; scrollbar-width:none; gap:4px; }
.ps-pill .ps-states button { background:#fff1; font-weight:500; }
.ps-pill .ps-states button[aria-pressed="true"] { background:#fff; color:#000; font-weight:700; }
.ps-pill .ps-pick { background:var(--accent, #fff); color:var(--on-accent, #000); font-weight:700; }
.ps-closed { box-sizing:border-box; min-height:44px; display:flex; align-items:center; justify-content:center; padding:0 11px; border-radius:999px; color:#fffa; background:#fff1; white-space:nowrap; }
.ps-switch .ps-text { margin-bottom:6px; resize:none; border-radius:12px; border:1px solid #fff3; background:#000d; color:#fff;
  padding:7px 10px; font:400 16px -apple-system, system-ui, sans-serif; }
.ps-switch .ps-text::placeholder { color:#fffa; }
.ps-switch .ps-text[hidden] { display:none; }
.ps-picked { box-sizing:border-box; min-height:44px; display:flex; align-items:center; justify-content:center; padding:0 11px; border-radius:999px; color:#fff; background:#1f9d55; white-space:nowrap; }
.ps-note { margin-bottom:6px; background:#000d; color:#fff; border-radius:8px; padding:5px 10px; font:500 12px -apple-system, system-ui, sans-serif; text-align:center; }
.ps-note[hidden] { display:none; }
@media (min-width: 900px) {
  .ps-switch { align-items:center; }
  .ps-pill { width:min(640px, 100%); }
  .ps-switch .ps-text { width:min(640px, 100%); }
  .ps-states { flex-wrap:wrap; overflow-x:visible; }
}
.ps-pane main.proto-main { padding-top:0; }
.ps-pane .ps-top { display:none; }
.ps-pane .ps-states { flex-wrap:wrap; overflow-x:visible; justify-content:center; }`;

  const typing = (el) => Boolean(el?.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"])'));

  function mount({ takes, states = null, initial, render, above = null }) {
    const keys = Object.keys(takes);
    const params = new URLSearchParams(location.search);
    let shownState = states ? startTake(Object.keys(states), params.get('state')) : null;
    const qid = params.get('q');
    const site = globalThis.ClaudeSite;
    if (!document.getElementById('ps-style')) document.head.insertAdjacentHTML('beforeend', `<style id="ps-style">${CSS}</style>`);
    // Framed in the board's right pane (app-needs.js openViewer), whose top bar holds the way back and the Round pill.
    if (window.frameElement?.closest('.needs-pane')) document.documentElement.classList.add('ps-pane');
    let take = startTake(keys, params.get('variant'), initial);
    let question = null;
    // A push opened this page (board/store.mjs pushUrl). Read once and dropped from the URL, so a reload stays on the
    // page; only the first load sends an already-picked question on to its card's thread.
    let fromPush = params.get('from') === 'push';
    if (fromPush) { const u = new URL(location.href); u.searchParams.delete('from'); history.replaceState(null, '', u); }

    const box = document.createElement('div');
    box.className = 'ps-switch';
    box.innerHTML = '<div class="ps-note" role="status" hidden></div><textarea class="ps-text" rows="2" placeholder="Note with your pick (optional)" aria-label="Note with your pick" hidden></textarea><div class="ps-pill"></div>';
    if (above) box.prepend(above);
    box.classList.add('ps-pending');
    document.body.append(box);
    // The footer's height, so the page above it ends where it starts (prototype.html reads --ps-footer-h).
    const measure = () => document.documentElement.style.setProperty('--ps-footer-h', `${box.offsetHeight}px`);
    new ResizeObserver(measure).observe(box);
    const pill = box.querySelector('.ps-pill');
    const noteEl = box.querySelector('.ps-note');
    const text = box.querySelector('.ps-text');
    // The ✕ and, on a card with earlier rounds, the Round pill and its sheet. boardCard: /api/board's card the question is on.
    const top = document.createElement('div');
    top.className = 'ps-top ps-pending';
    document.body.append(top);
    let boardCard = null;
    let sheet = false;
    const paintTop = () => {
      const rounds = boardCard?.prototypes?.rounds;
      const { roundPill, roundSheet } = globalThis.BoardUI;
      top.innerHTML = `${roundPill(rounds, qid)}<button type="button" class="ps-close" data-ps-top="close" aria-label="Close">✕</button>${sheet && rounds ? roundSheet({ ref: boardCard.ref, rounds, qid }) : ''}`;
    };
    paintTop();

    const note = (text) => { noteEl.textContent = text || ''; noteEl.hidden = !text; };
    const state = () => pickState(question, take, qid ? readDraft(qid).choice : null);
    function paint() {
      const now = state();
      pill.innerHTML = pillHtml({ name: takes[take], pick: now, states, state: shownState });
      text.hidden = !(now.kind === 'pick' || now.kind === 'change' || now.kind === 'picked');
    }
    function go(next) {
      take = next;
      const u = new URL(location.href); u.searchParams.set('variant', take); history.replaceState(null, '', u);
      note('');
      paint();
      render(take, shownState);
    }
    function show(next) {
      shownState = next;
      const u = new URL(location.href); u.searchParams.set('state', next); history.replaceState(null, '', u);
      paint();
      render(take, shownState);
    }

    // The footer and the Round pill stay hidden until the first load settles (or 1.5s pass), so they appear complete in one paint.
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      measure();
      box.classList.remove('ps-pending');
      top.classList.remove('ps-pending');
    };
    setTimeout(reveal, 1500);
    async function load() {
      try { await fetchQuestion(); } finally { reveal(); }
    }
    async function fetchQuestion() {
      if (!qid || !site) return;
      try {
        const board = await (await fetch(site.url('api/board'), { cache: 'no-store' })).json();
        // A resolved question is left out of /api/board, and its topic's resolved questions hold it
        // (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md).
        const topic = board.ownerTopics.find((t) => t.questions.includes(qid));
        question = board.owner.find((q) => q.id === qid)
          || (topic && (await (await fetch(site.url('api/questions?topic=' + encodeURIComponent(topic.id)), { cache: 'no-store' })).json()).questions.find((q) => q.id === qid))
          || null;
        if (!question) note('This prototype’s question is gone, so there is nothing to pick.');
        boardCard = topic && board.items.find((i) => i.questions?.topic === topic.id) || null;
        paintTop();
      } catch { /* keep the last question shown */ }
      if (fromPush && pickedChoice(question)) {
        const card = /^item:(.+)$/.exec(question.topic || '')?.[1];
        replaceWith(site.url(card ? `#selectedCard=${encodeURIComponent(card)}&reply` : 'questions.html'));
        return;
      }
      if (question && !text.value) text.value = readDraft(qid).note || '';
      fromPush = false;
      paint();
    }

    function pick() {
      const now = state();
      if (!(now.kind === 'pick' || now.kind === 'change')) return;
      writeDraft(qid, { ...readDraft(qid), choice: now.option.id, note: text.value.trim() });
      replaceWith(site.url(`questions.html#${encodeURIComponent(qid)}`));
    }
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      pick();
    });

    pill.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-ps-state]')?.dataset.psState;
      if (chip) { show(chip); return; }
      const act = e.target.closest('[data-ps]')?.dataset.ps;
      if (act === 'prev') go(takeAt(keys, take, -1));
      else if (act === 'next') go(takeAt(keys, take, 1));
      else if (act === 'pick') pick();
    });
    // ✕ follows the hidden header's back arrow, so it goes where back goes (router.js page tree).
    top.addEventListener('click', (e) => {
      const round = e.target.closest('[data-ps-round]')?.dataset.psRound;
      if (round) { replaceWith(site.url(round)); return; }
      const act = e.target.closest('[data-ps-top]')?.dataset.psTop;
      if (act === 'close') document.querySelector('header.top a.back').click();
      else if (act === 'rounds') { sheet = !sheet; paintTop(); }
    });
    document.addEventListener('keydown', (e) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') go(takeAt(keys, take, -1));
      else if (e.key === 'ArrowRight') go(takeAt(keys, take, 1));
      else if (e.key === 'Escape' && sheet) { sheet = false; paintTop(); }
    });
    // A swipe that starts in a box scrolling sideways is that box's own scroll.
    let touch = null;
    document.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      const scrolls = (el) => el && el !== document.body && (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX) ? true : scrolls(el.parentElement));
      touch = e.touches.length === 1 && !typing(e.target) && !e.target.closest?.('.ps-sheet') && !scrolls(e.target) ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const step = touch && t ? swipeStep(touch, { x: t.clientX, y: t.clientY }) : 0;
      touch = null;
      if (step) go(takeAt(keys, take, step));
    }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

    go(take);
    measure();
    load();
    return { takes: keys, get take() { return take; }, get state() { return shownState; }, go, show };
  }

  globalThis.PrototypeSwitcher = { takeAt, startTake, pickedChoice, pickState, pillHtml, swipeStep, mount };
})();
