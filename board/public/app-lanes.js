// The board view's lanes and wave filter: each lane's header and cards, the "N older" and finished-wave folds, and the wave bars.
// Needs app-core.js and app-cards.js.
BoardView.part((B) => {
  const { $, store, state } = B;
  const { esc } = BoardUI;
  const LANES = [
    { id: 'review', name: 'In Review', open: true },
    { id: 'stale', name: 'Stale', open: true, hideEmpty: true },
    { id: 'progress', name: 'In Progress', open: true },
    { id: 'todo', name: 'Todo', open: true },
    { id: 'done', name: 'Done', open: false },
  ];

  // A fold's open state lives in storage, not in setHTML's summary-text match, because its row's count changes.
  // Fold ids are 'older', 'asks' or wave:<slug> (board/domain.mjs), so any id maps to its own storage key.
  const FOLDS = new Proxy({}, { get: (_, id) => ({ store: `foldOpen:${String(id)}` }) });
  // A fold's header reads like a lane's: its name, then its count, then an optional note.
  function fold(id, list, name, note = '') {
    if (!list.length) return '';
    return `<details class="fold" data-fold="${esc(id)}" ${store.get(FOLDS[id].store, false) ? 'open' : ''}>
        <summary><span class="lane-name">${name}</span><span class="count">${list.length}</span>${note ? `<span class="count">· ${note}</span>` : ''}</summary>
        <div class="fold-list">${list.map((it) => B.card(it)).join('')}</div>
      </details>`;
  }

  // One row per finished wave, newest card first, as Done's items arrive sorted.
  function waveFolds(d, items) {
    const slugs = [...new Set(items.filter((i) => i.fold === `wave:${i.wave}`).map((i) => i.wave))];
    return slugs.map((slug) => {
      const w = d.waves.find((x) => x.slug === slug);
      const { dropped } = w.finished;
      return fold(`wave:${slug}`, items.filter((i) => i.fold === `wave:${slug}`), esc(w.title), dropped ? `${dropped} dropped` : '');
    }).join('');
  }

  // shown is the board's items after the wave filter and pending deletes.
  function lanesHtml(d, shown) {
    const laneState = store.get('lanes', {});
    return LANES.map((lane) => {
      const items = shown.filter((i) => i.lane === lane.id);
      if (lane.hideEmpty && !items.length) return '';
      const open = laneState[lane.id] ?? lane.open;
      const older = items.filter((i) => i.fold === 'older');
      const asks = items.filter((i) => i.fold === 'asks');
      const rows = items.filter((i) => !i.fold).map((it) => B.card(it)).join('') + fold('asks', asks, 'Answered')
        + waveFolds(d, items) + fold('older', older, 'Older');
      return `<details class="lane" data-lane="${lane.id}" ${open ? 'open' : ''}>
        <summary><span class="lane-name">${lane.name}</span><span class="count">${items.length}</span>${lane.id === 'review' ? B.githubHeader(d) : ''}</summary>
        <div class="list">${rows || '<div class="empty">Nothing here.</div>'}
        ${lane.id === 'todo' ? BoardUI.planButton(items) : ''}</div>
      </details>`;
    }).join('');
  }

  function renderWaves(d) {
    if (d.waves.some((w) => w.finished && w.slug === state.waveFilter)) { state.waveFilter = null; store.set('wave', null); }
    const rows = d.waves.map((w) => {
      const items = d.items.filter((i) => i.wave === w.slug);
      const merged = items.filter((i) => i.pr?.state === 'MERGED' || (!i.pr && i.lane === 'done')).length;
      const drafts = items.filter((i) => i.pr?.state === 'OPEN' && i.pr.isDraft).length;
      const review = items.filter((i) => i.pr?.state === 'OPEN' && !i.pr.isDraft).length;
      return { w, total: items.length, merged, drafts, review };
    }).filter((r) => r.total && !r.w.finished);
    $('#waves').innerHTML = rows.map(({ w, total, merged, drafts, review }) => `<button class="wave ${w.slug === state.waveFilter ? 'on' : ''}" data-wave="${esc(w.slug)}">
        <span class="wave-name">${esc(w.title)}</span>
        <span class="muted small">${merged} of ${total} ${w.internal ? 'done' : 'merged'}${review ? ` · ${review} in review` : ''}${drafts ? ` · ${drafts} draft${drafts === 1 ? '' : 's'}` : ''}</span>
        <span class="bar"><span style="width:${Math.round((merged / total) * 100)}%"></span></span>
      </button>`).join('');
  }

  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (el.matches?.('details.lane')) {
      const s = store.get('lanes', {}); s[el.dataset.lane] = el.open; store.set('lanes', s);
    } else if (el.matches?.('details.fold')) store.set(FOLDS[el.dataset.fold].store, el.open);
  }, true);

  B.on(B.root, 'click', async (ev) => {
    const pb = ev.target.closest('button[data-plan]');
    if (pb) {
      if (!(await B.confirm('Claude groups these follow-ups into a small wave and asks you about the plan in Needs you. Nothing builds until you answer. Start?'))) return;
      pb.disabled = true;
      try { await B.site.send('plan-followups', { keys: pb.dataset.plan.split(' ') }); pb.textContent = 'Planning… its questions appear in Needs you'; }
      catch { B.notice('Could not send. Is the host awake?'); pb.disabled = false; }
      return;
    }
    const wb = ev.target.closest('button[data-wave]');
    if (wb) { state.waveFilter = wb.dataset.wave !== state.waveFilter ? wb.dataset.wave : null; store.set('wave', state.waveFilter); B.render(); }
  });

  Object.assign(B, { FOLDS, lanesHtml, renderWaves });
});
