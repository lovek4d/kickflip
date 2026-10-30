// Work cards on the board page: a card in a lane, its expanded detail, its action row with each button's confirmation, and opening it. Needs
// app-core.js and app-threads.js.
(function () {
  const B = globalThis.BoardApp;
  const { store, state, markSeen, seen, toast, links } = B;
  const { esc, REVIEW, reviewAge, unreadCount, workLines, linkText, mergeButton } = BoardUI;

  function detail(it) {
    if (it.kind === 'ask') return `<div class="detail">${B.thread(it.key)}</div>`;
    const pr = it.pr;
    const ctx = links(it.key);
    const rows = [];
    rows.push(['Wave', esc(it.waveTitle)]);
    if (pr) {
      const ci = pr.checks ? `${pr.checks.state}${pr.checks.fail ? ` (${pr.checks.fail} failing)` : pr.checks.pending ? ` (${pr.checks.pending} running)` : ''}` : 'unknown';
      if (pr.state === 'OPEN') {
        rows.push(['CI', esc(ci)]);
        rows.push(['Merge', esc([pr.mergeStateStatus, pr.reviewDecision].filter(Boolean).join(' · ').toLowerCase() || 'unknown')]);
        rows.push(['Review', (it.reviewers || []).map((r) => `${esc(r)} <span class="muted">${REVIEW[it.review?.[r]?.state || 'unsent'].label}${reviewAge(it.review?.[r]) ? `,${reviewAge(it.review[r])}` : ''}</span>`).join(' · ') || '—']);
      }
    }
    if (it.branch) rows.push(['Branch', `<code>${esc(it.branch)}</code>`]);
    if (it.status) rows.push(['Status', esc(it.status)]);
    if (it.deps.length) rows.push(['Waits on', esc(it.deps.join(', '))]);
    if (it.manualSteps.length) rows.push(['Manual steps', linkText(it.manualSteps.join('; '), ctx)]);
    if (it.slack) rows.push(['Slack', `<a href="${esc(it.slack)}" target="_blank" rel="noopener">thread</a>`]);
    if (it.from) rows.push(['Filed from', esc(it.from)]);
    if (it.next) rows.push(['Next', linkText(it.next, ctx)]);

    return `<div class="detail">
      <dl class="grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${actions(it)}
      ${B.thread(it.key)}
    </div>`;
  }

  // docs/adr/0023-a-card-can-be-held-and-every-card-button-confirms.md
  const sendingHold = new Map();
  const sendingMerge = new Set();
  const refFor = (it) => (it.kind !== 'work' || it.internal ? it.ref : it.linear?.[0]?.id || (it.pr ? `#${it.pr.number}` : it.ref));
  const CONFIRM = {
    hold: (it, ref) => `Hold ${ref}? ${it.lane === 'todo' ? "It won't start" : 'Claude stops work on it'} until you resume it.`,
    resume: (it, ref) => `Resume ${ref}? It can start again once nothing blocks it.`,
    bump: (it, ref) => `Move ${ref} to the top of its lane?`,
    grill: (it, ref) => `Ask Claude for questions about ${ref}?`,
    merge: (it, ref) => `Merge ${ref}? Claude squash-merges #${it.pr?.number} if it is still approved, green and clean.`,
    build: (it, ref) => `Build ${ref}? Claude replies with a short plan, then builds it as a draft.`,
    finish: (it, ref) => (it.kind === 'ask' ? `Mark this task done? "${it.title}" moves to Done.`
      : `Close ${ref}? It moves to Done and Claude stops work on it.${it.pr?.state === 'OPEN' ? ' Its PR stays open on GitHub.' : ''}`),
  };

  function actions(it) {
    const key = esc(it.key);
    const pr = it.pr;
    const draftPR = pr && pr.state === 'OPEN' && pr.isDraft;
    const ask = (act, label, disabled) => `<button data-confirm="${act}" data-key="${key}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const holding = sendingHold.has(it.key) ? sendingHold.get(it.key) : it.holdPending;
    const hold = it.kind !== 'work' || !it.holdable ? ''
      : holding != null ? `<button disabled>${holding ? 'Holding…' : 'Resuming…'}</button>`
      : it.held ? ask('resume', 'Resume') : ask('hold', 'Hold');
    const topBump = Boolean(it.bumpedAt) && !state.board.items.some((i) => i.lane === it.lane && (i.bumpedAt || '') > it.bumpedAt);
    const prioritize = it.bumpable ? ask('bump', 'Prioritize', topBump) : '';
    const asking = it.questions?.open && it.questions.state !== 'resolved';
    const answer = it.action?.kind === 'pick' || it.action?.kind === 'questions' ? it.action.url : `questions.html#${it.questions?.first}`;
    const grill = asking
      ? `<a class="button answer" href="${esc(answer)}">${it.action ? 'Action needed' : 'Questions'}</a>`
      : it.grilling ? '<button disabled>Writing questions…</button>'
      : ask('grill', 'Grill');
    return `<div class="actions" data-actions="${key}">
        ${draftPR ? `<a class="pill" href="${esc(pr.url)}" target="_blank" rel="noopener">Review #${esc(pr.number)} on GitHub →</a>` : ''}
        ${it.kind === 'followup' && it.lane !== 'done' ? `<button class="build" data-confirm="build" data-key="${key}">Build</button>` : ''}
        ${mergeButton(it, sendingMerge.has(it.key))}${hold}${prioritize}${grill}
        ${it.hasNotes ? `<a class="pill" href="notes.html?item=${encodeURIComponent(it.key)}">Notes →</a>` : ''}
      </div>`;
  }

  // The latest bump among New cards takes no second bump (docs/adr/0014-a-pending-ask-can-be-deleted-or-bumped.md).
  const topNew = (it) => Boolean(it.isNew && it.bumpedAt) && !state.board.items.some((i) => i.isNew && (i.bumpedAt || '') > it.bumpedAt);
  function card(it) {
    return `<details class="item" data-key="${esc(it.key)}" ${state.openItems.has(it.key) ? 'open' : ''}>
          <summary class="work">
            <span class="status ${it.lane}"></span>
            <div class="title-wrap">${workLines(it, { unread: state.openItems.has(it.key) ? 0 : unreadCount(it.othersAt, seen[it.key]), top: topNew(it) })}</div>
          </summary>
          ${state.openItems.has(it.key) ? detail(it) : ''}
        </details>`;
  }

  document.addEventListener('toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item')) return;
    const key = el.dataset.key;
    if (el.open) {
      state.openItems.add(key);
      const it = state.board.items.find((i) => i.key === key);
      markSeen(it);
      el.querySelector('.unread')?.remove();
      if (it && !el.querySelector('.detail')) { el.insertAdjacentHTML('beforeend', detail(it)); }
      if (state.threadCache.has(key)) B.renderThread(key, state.threadCache.get(key));
      B.loadThread(key, { maxAge: 10000 });
    } else {
      state.openItems.delete(key);
    }
    store.set('openItems', [...state.openItems]);
  }, true);

  function redrawActions(key) {
    const it = state.board.items.find((i) => i.key === key);
    const row = document.querySelector(`.actions[data-actions="${CSS.escape(key)}"]`);
    if (it && row) row.outerHTML = actions(it);
  }

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-confirm]');
    if (!b) return;
    ev.preventDefault();
    const { key, confirm: act } = b.dataset;
    const it = state.board.items.find((i) => i.key === key);
    if (!it || !(await B.confirm(CONFIRM[act](it, refFor(it))))) return;
    if (act === 'hold' || act === 'resume') {
      sendingHold.set(key, act === 'hold');
      redrawActions(key);
      try { await ClaudeSite.send('card-hold', { key, hold: act === 'hold' }); }
      catch { toast(`Could not ${act}. Is the Mac awake?`, 3000); }
      sendingHold.delete(key);
      B.loadBoard();
      return;
    }
    // docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md
    if (act === 'merge') {
      sendingMerge.add(key);
      redrawActions(key);
      try { await ClaudeSite.send('card-merge', { key }); }
      catch { toast('Could not send. Is the Mac awake?', 3000); }
      sendingMerge.delete(key);
      B.loadBoard();
      return;
    }
    // docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md
    if (act === 'finish') {
      B.sendingDone.add(key);
      B.syncDone(key);
      try { await (it.kind === 'ask' ? ClaudeSite.send('ask-done', { id: it.id }) : ClaudeSite.send('card-done', { key })); }
      catch { toast('Could not close. Is the Mac awake?', 3000); }
      B.sendingDone.delete(key);
      await B.loadBoard();
      B.syncDone(key);
      return;
    }
    const row = document.querySelector(`.actions[data-actions="${CSS.escape(key)}"]`);
    row?.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      if (act === 'bump') { await ClaudeSite.send('card-bump', { key }); toast('Moved to the top', 2500); }
      else { await ClaudeSite.send(act === 'grill' ? 'grill-more' : 'build-followup', { key }); B.loadThread(key, { force: true }); }
    } catch { toast('Could not send. Is the Mac awake?', 3000); }
    B.loadBoard();
  });

  Object.assign(B, { detail, card });
})();
