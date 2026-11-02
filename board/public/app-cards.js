// Work cards on the board view: a card in a lane, its expanded detail, its action row with each button's confirmation, and opening it. Needs
// app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, store, state, markSeen, seen, toast, links } = B;
  const { esc, REVIEW, reviewAge, unreadCount, workLines, linkText, mergeButton, installButton, tryButton, tryWords, BUTTON, LINK_ARROW } = BoardUI;

  function detail(it) {
    if (it.kind === 'ask') {
      const button = actionButton(it);
      return `<div class="detail">${button ? `<div class="actions" data-actions="${esc(it.key)}">${actionRow('workflow', button)}</div>` : ''}${B.thread(it.key)}</div>`;
    }
    const pr = it.pr;
    const ctx = links(it.key);
    const rows = [];
    rows.push(['Wave', esc(it.waveTitle)]);
    if (pr) {
      const ci = pr.checks ? `${pr.checks.state}${pr.checks.fail ? ` (${pr.checks.fail} failing)` : pr.checks.pending ? ` (${pr.checks.pending} running)` : ''}` : 'unknown';
      if (pr.state === 'OPEN') {
        rows.push(['CI', esc(ci)]);
        rows.push(['Merge', esc([pr.mergeStateStatus, pr.reviewDecision].filter(Boolean).join(' · ').toLowerCase() || 'unknown')]);
        rows.push(['Review', (it.reviewers || []).map((r) => `${esc(r)} <span class="muted">${REVIEW[BoardUI.record(it.review, r)?.state || 'unsent'].label}${reviewAge(BoardUI.record(it.review, r)) ? `,${reviewAge(BoardUI.record(it.review, r))}` : ''}</span>`).join(' · ') || '—']);
      }
    }
    if (it.branch) rows.push(['Branch', `<code>${esc(it.branch)}</code>`]);
    if (it.status) rows.push(['Status', esc(it.status)]);
    if (it.deps.length) rows.push(['Waits on', esc(it.deps.join(', '))]);
    if (it.manualSteps.length) rows.push(['Manual steps', linkText(it.manualSteps.join('; '), ctx)]);
    if (it.from) rows.push(['Filed from', esc(it.from)]);
    if (it.next) rows.push(['Next', linkText(it.next, ctx)]);
    // docs/adr/0062-notes-is-a-link-in-the-details-list.md
    const external = [
      it.hasNotes ? `<a href="notes.html?item=${encodeURIComponent(it.key)}">Notes ${LINK_ARROW}</a>` : '',
      installButton(it),
      pr?.state === 'OPEN' ? `<a${classes(it, BUTTON.github)} href="${esc(pr.url)}" target="_blank" rel="noopener">${pr.isDraft ? 'Review draft on GitHub' : 'Review on GitHub'} ${LINK_ARROW}</a>` : '',
    ].filter(Boolean);
    const externalRow = external.length ? `<dt class="external-links-label">Links</dt><dd class="external-links">${external.map((html, i) => `<span class="external-link">${i ? '<span class="external-separator" aria-hidden="true"> · </span>' : ''}${html}</span>`).join('')}</dd>` : '';

    return `<div class="detail">
      <dl class="grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}${externalRow}</dl>
      ${actions(it)}
      ${B.thread(it.key)}
    </div>`;
  }

  const sendingMerge = new Set();
  const refFor = (it) => (it.kind !== 'work' || it.internal ? it.ref : it.linear?.[0]?.id || (it.pr ? `#${it.pr.number}` : it.ref));
  const CONFIRM = {
    hold: (it, ref) => `Hold ${ref}? ${it.lane === 'todo' ? "It won't start" : 'Claude stops work on it'} until you resume it.`,
    resume: (it, ref) => `Resume ${ref}? It can start again once nothing blocks it.`,
    bump: (it, ref) => `Move ${ref} to the top of its lane?`,
    nudge: () => 'Nudge Claude to check this builder?',
    grill: (it, ref) => `Ask Claude for questions about ${ref}?`,
    merge: (it, ref) => `Merge ${ref}? Claude squash-merges #${it.pr?.number} if it is still approved, green and clean.`,
    build: (it, ref) => `Build ${ref}? Claude replies with a short plan, then builds it as a draft.`,
    finish: (it, ref) => (it.kind === 'ask' ? `Mark this task done? "${it.title}" moves to Done.`
      : `Close ${ref}? It moves to Done and Claude stops work on it.${it.pr?.state === 'OPEN' ? ' Its PR stays open on GitHub.' : ''}`),
  };

  const classes = (it, button, base = '') => {
    const names = [base, it.resolvedBy === button && 'resolves'].filter(Boolean).join(' ');
    return names ? ` class="${names}"` : '';
  };
  const actionRow = (kind, html) => (html.trim() ? `<div class="action-row ${kind}">${html}</div>` : '');

  function actions(it) {
    const key = esc(it.key);
    const ask = (act, label) => `<button data-confirm="${act}" data-key="${key}">${label}</button>`;
    const hold = it.kind !== 'work' || !it.holdable ? ''
      : it.held ? ask('resume', 'Resume') : ask('hold', 'Hold');
    const build = it.kind === 'followup' && it.lane !== 'done' ? `<button class="build" data-confirm="build" data-key="${key}">Build</button>` : '';
    return `<div class="actions" data-actions="${key}">${actionRow('workflow', `${build}${mergeButton(it, sendingMerge.has(it.key))}${hold}${actionButton(it)}${tryButton(it)}`)}</div>`;
  }

  // board/domain.mjs actionButtonOf picks the button and resolvedBy its colour (docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md).
  const ACTION_BUTTONS = {
    [BUTTON.openQuestions]: (it) => `<a${classes(it, BUTTON.openQuestions, 'button')} href="questions.html#${esc(it.questions.first)}">Open questions</a>`,
    [BUTTON.markDone]: (it) => `<button${classes(it, BUTTON.markDone)} data-confirm="finish" data-key="${esc(it.key)}">Mark as done</button>`,
    [BUTTON.grill]: (it) => (it.grilling ? '<button disabled>Writing questions…</button>' : `<button data-confirm="grill" data-key="${esc(it.key)}">Grill</button>`),
  };
  const actionButton = (it) => ACTION_BUTTONS[it.actionButton]?.(it) || '';

  // The latest bump takes no second bump: among New cards for a New card (docs/adr/0014-a-pending-ask-can-be-deleted-or-bumped.md),
  // in its lane for any other card (docs/adr/0019-a-card-that-hasnt-started-can-be-bumped.md).
  const latestBump = (it) => Boolean(it.bumpedAt) && !state.board.items.some((i) => (it.isNew ? i.isNew : i.lane === it.lane) && (i.bumpedAt || '') > it.bumpedAt);
  function card(it) {
    return `<details class="item" data-key="${esc(it.key)}" ${state.openItems.has(it.key) ? 'open' : ''}>
          <summary class="work">
            <span class="status ${it.lane}"></span>
            <div class="title-wrap">${workLines(it, { unread: state.openItems.has(it.key) ? 0 : unreadCount(it.othersAt, seen[it.key]), top: latestBump(it) })}</div>
          </summary>
          ${state.openItems.has(it.key) ? detail(it) : ''}
        </details>`;
  }

  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item')) return;
    const key = el.dataset.key;
    if (el.open) {
      state.openItems.add(key);
      const it = state.board.items.find((i) => i.key === key);
      markSeen(it);
      const unread = el.querySelector('summary .chip.unread');
      const row = unread?.parentNode;
      unread?.remove();
      if (row && !row.children.length) row.remove();
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
    const row = $(`.actions[data-actions="${CSS.escape(key)}"]`);
    if (it && row) row.outerHTML = actions(it);
  }

  B.on(B.root, 'click', async (ev) => {
    const log = ev.target.closest('[data-try-log]');
    if (log && state.openItems.has(log.dataset.tryLog)) {
      ev.preventDefault();
      const card = log.closest('details.item');
      card?.querySelector('.thread')?.scrollIntoView({ block: 'start' });
      return;
    }
    const button = ev.target.closest('button[data-try]');
    if (!button) return;
    ev.preventDefault();
    if (button.dataset.tip) { toast(button.dataset.tip); return; }
    const key = button.dataset.try;
    const it = state.board.items.find((i) => i.key === key);
    if (!it || !(await B.confirm(`${tryWords(it.try?.kind).go} ${it.ref}? The hub runs its build script.`)) || !B.alive()) return;
    button.disabled = true;
    try {
      const r = await fetch(B.site.url('api/try'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'The hub refused the build.');
    } catch (error) { toast(error.message || 'Could not start. Is the host awake?'); }
    if (B.alive()) B.loadBoard();
  });

  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('button[data-confirm]');
    if (!b) return;
    ev.preventDefault();
    const { key, confirm: act } = b.dataset;
    const it = state.board.items.find((i) => i.key === key);
    if (!it || !(await B.confirm(CONFIRM[act](it, refFor(it))))) return;
    if (act === 'hold' || act === 'resume') {
      try { await B.site.send('card-hold', { key, hold: act === 'hold' }); }
      catch { toast(`Could not ${act}. Is the host awake?`); }
      B.loadBoard();
      return;
    }
    // docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md
    if (act === 'merge') {
      sendingMerge.add(key);
      redrawActions(key);
      try { await B.site.send('card-merge', { key }); }
      catch { toast('Could not send. Is the host awake?'); }
      sendingMerge.delete(key);
      B.loadBoard();
      return;
    }
    // docs/adr/0106-the-board-applies-the-owners-hold-resume-and-done-at-once.md
    if (act === 'finish') {
      try { await (it.kind === 'ask' ? B.site.send('ask-done', { id: it.id }) : B.site.send('card-done', { key })); }
      catch { toast('Could not close. Is the host awake?'); }
      await B.loadBoard();
      B.syncDone(key);
      return;
    }
    const row = $(`.actions[data-actions="${CSS.escape(key)}"]`);
    row?.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    b.disabled = true;
    try {
      if (act === 'bump') { await B.site.send('card-bump', { key }); toast('Moved to the top'); }
      else if (act === 'nudge') { await B.site.send('builder-nudge', { key }); b.textContent = 'Sent'; toast('Nudge sent'); }
      else { await B.site.send(act === 'grill' ? 'grill-more' : 'build-followup', { key }); B.loadThread(key, { force: true }); }
    } catch { toast('Could not send. Is the host awake?'); }
    B.loadBoard();
  });

  Object.assign(B, { detail, card });
});
