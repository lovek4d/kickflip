// The board view's lanes and the Waves section above them: each lane's header and cards, the "N older" and finished-wave
// folds, each lane's sort menu, and the wave rows that filter the lanes and start a wave's triage.
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

  // Each lane's order, kept per lane on this device: items arrive touched first, and created uses domain.mjs rank.created.
  const SORTS = { touched: 'Recently touched', created: 'Recently created' };
  const SORT_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16"/><path d="m3 8 4-4 4 4"/><path d="M17 20V4"/><path d="m13 16 4 4 4-4"/></svg>';
  const TICK = '<svg class="tick" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  let sortMenu = null;
  const sortOf = (id) => (store.get('laneSort', {})[id] === 'created' ? 'created' : 'touched');
  function sortControl(lane, by) {
    const open = sortMenu === lane.id;
    const menu = open ? `<div class="lane-sort-menu" role="menu" aria-label="Sort ${lane.name}">${Object.entries(SORTS).map(([o, label]) =>
      `<button type="button" role="menuitemradio" aria-checked="${o === by}" data-sort-pick="${o}"><span>${label}</span>${o === by ? TICK : ''}</button>`).join('')}<p class="lane-sort-note">Kept for this lane on this device.</p></div>` : '';
    return `<button type="button" class="lane-sort" data-lane-sort="${lane.id}" aria-haspopup="menu" aria-expanded="${open}" aria-label="Sort ${lane.name}, now ${SORTS[by].toLowerCase()}" title="Sort">${SORT_ICON}</button>${menu}`;
  }

  // shown is the board's items after the wave filter and pending deletes.
  function lanesHtml(d, shown) {
    const laneState = store.get('lanes', {});
    return LANES.map((lane) => {
      const by = sortOf(lane.id);
      const items = shown.filter((i) => i.lane === lane.id);
      if (by === 'created') items.sort((a, b) => a.rank.created - b.rank.created);
      if (lane.hideEmpty && !items.length) return '';
      const open = laneState[lane.id] ?? lane.open;
      const older = items.filter((i) => i.fold === 'older');
      const asks = items.filter((i) => i.fold === 'asks');
      const rows = items.filter((i) => !i.fold).map((it) => B.card(it)).join('') + fold('asks', asks, 'Answered')
        + waveFolds(d, items) + fold('older', older, 'Older');
      return `<details class="lane" data-lane="${lane.id}" ${open ? 'open' : ''}>
        <summary><span class="lane-name">${lane.name}</span><span class="count">${items.length}</span>${lane.id === 'review' ? B.githubHeader(d) : ''}${sortControl(lane, by)}</summary>
        <div class="list">${rows || '<div class="empty">Nothing here.</div>'}
        ${lane.id === 'todo' ? BoardUI.planButton(items) : ''}</div>
      </details>`;
    }).join('');
  }

  // The Waves section: a lane of one row per open wave (domain.mjs waveRowsOf). Tapping a row shows only its cards;
  // Notes and Triage act without filtering. A lineup has them at the row's foot, and a wave file has only Triage, at
  // the end of its name line.
  const triaging = new Set();
  const triageTopic = (r) => `${r.kind}:${r.slug}`;
  function triageLink(r) {
    if (r.triage.running || triaging.has(triageTopic(r))) return '<span class="wv-busy" role="status"><span class="try-spin" aria-hidden="true"></span>Triaging…</span>';
    if (r.triage.questions) return `<span class="muted">Triage: ${B.plural(r.triage.questions, 'open question')}</span>`;
    return `<button type="button" class="wv-link" data-triage="${esc(triageTopic(r))}">Triage</button>`;
  }
  function waveRow(r) {
    const on = r.slug === state.waveFilter;
    const lineup = r.kind === 'lineup';
    const links = lineup ? `<div class="wv-links"><span class="external-link"><a href="notes.html?wave=${encodeURIComponent(r.slug)}">Notes ${BoardUI.LINK_ARROW}</a></span><span class="external-link"><span class="external-separator" aria-hidden="true"> · </span>${triageLink(r)}</span></div>` : '';
    return `<div class="wv-row${on ? ' on' : ''}" data-wave-row="${esc(r.slug)}">
        <div class="wv-id"><button type="button" class="wv-name" aria-pressed="${on}">${BoardUI.WAVE_ICON}<span>${esc(r.title)}</span></button><span class="muted small">${r.merged} of ${r.total} merged</span>${lineup ? '' : `<span class="wv-end">${triageLink(r)}</span>`}</div>
        ${r.goal ? `<div class="wv-note"><b>Goal</b> ${esc(r.goal)}</div>` : ''}
        ${r.order ? `<div class="wv-note"><b>Order</b> ${r.order.map((o) => esc(o.ref)).join(' → ')}</div>` : ''}
        ${links}
      </div>`;
  }
  function renderWaves(d) {
    const rows = d.waveRows || [];
    if (state.waveFilter && !rows.some((r) => r.slug === state.waveFilter)) { state.waveFilter = null; store.set('wave', null); }
    const open = store.get('lanes', {}).waves ?? true;
    const shown = rows.find((r) => r.slug === state.waveFilter);
    BoardUI.setHTML($('#waves'), rows.length ? `<details class="lane" data-lane="waves" ${open ? 'open' : ''}>
        <summary><span class="lane-name">Waves</span><span class="count">${rows.length}</span></summary>
        <div class="list">${rows.map(waveRow).join('')}</div>
      </details>${shown ? `<div class="wv-showing muted small">Showing ${esc(shown.title)} only · <button type="button" class="wv-all">Show all</button></div>` : ''}` : '');
  }
  // The menu sits in the lane's summary, so a tap on it, the icon included, must not fold the lane.
  const setSortMenu = (id) => { sortMenu = id; B.render(); };
  B.on(B.root, 'click', (ev) => {
    if (!ev.target.closest('.lane-sort, .lane-sort-menu')) return;
    ev.preventDefault();
    const pick = ev.target.closest('button[data-sort-pick]');
    if (pick) {
      store.set('laneSort', { ...store.get('laneSort', {}), [sortMenu]: pick.dataset.sortPick });
      setSortMenu(null);
      return;
    }
    const icon = ev.target.closest('button[data-lane-sort]');
    if (icon) {
      setSortMenu(sortMenu === icon.dataset.laneSort ? null : icon.dataset.laneSort);
      if (sortMenu) $(`details.lane[data-lane="${sortMenu}"] .lane-sort-menu [aria-checked="true"]`).focus({ preventScroll: true });
    }
  });
  B.on(document, 'click', (ev) => { if (sortMenu && !ev.target.closest?.('.lane-sort, .lane-sort-menu')) setSortMenu(null); });
  B.on(document, 'keydown', (ev) => {
    if (ev.key !== 'Escape' || !sortMenu) return;
    ev.preventDefault();
    const id = sortMenu;
    setSortMenu(null);
    $(`button[data-lane-sort="${id}"]`).focus();
  });

  const showWave = (slug) => { state.waveFilter = slug; store.set('wave', slug); B.render(); };

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
    const tb = ev.target.closest('button[data-triage]');
    if (tb) {
      const topic = tb.dataset.triage;
      const row = state.board.waveRows.find((r) => triageTopic(r) === topic);
      const asks = row.kind === 'lineup'
        ? `Claude reads the code for ${row.title}'s unstarted cards and asks you in Needs you about splitting, merging, adding or closing any. Start?`
        : `Claude checks ${row.title}'s unfinished cards, fixes what it can and asks you in Needs you about any that need you. Start?`;
      if (!(await B.confirm(asks))) return;
      triaging.add(topic);
      B.render();
      try { await B.site.send('wave-triage', { [row.kind]: row.slug }); await B.loadBoard(); }
      catch { B.notice('Could not send. Is the host awake?'); }
      finally { triaging.delete(topic); B.render(); }
      return;
    }
    const go = ev.target.closest('a[data-wave-show]');
    if (go) { ev.preventDefault(); showWave(go.dataset.waveShow); $('#waves').scrollIntoView({ block: 'start' }); return; }
    if (ev.target.closest('.wv-all')) { showWave(null); return; }
    const row = ev.target.closest('.wv-row');
    if (row && !ev.target.closest('a')) showWave(row.dataset.waveRow !== state.waveFilter ? row.dataset.waveRow : null);
  });

  Object.assign(B, { FOLDS, lanesHtml, renderWaves, sortOf });
});
