// The board view's lanes, the Auto Review lane leading them, and the Waves section above them: each lane's header and cards, Done's and Asks' Show more,
// Done's finished-wave folds, and the wave rows that filter the lanes and start a wave's triage.
// Needs app-core.js and app-cards.js.
BoardView.part((B) => {
  const { $, store, state } = B;
  const { esc } = BoardUI;
  const LANES = [
    { id: 'review', name: 'In Review', open: true },
    { id: 'stale', name: 'Stale', open: true, hideEmpty: true },
    { id: 'progress', name: 'In Progress', open: true },
    { id: 'todo', name: 'Todo', open: true },
    { id: 'done', name: 'Done', open: false, capped: true },
    { id: 'asks', name: 'Asks', open: false, capped: true },
  ];
  // docs/adr/0144-answered-asks-have-their-own-section-below-done.md
  // A capped lane shows STEP cards, and each Show more tap adds STEP more, kept in memory per lane. A card the owner has
  // open stays shown past the cap. Show more says how many are left (docs/adr/0012-lists-never-cut-silently.md).
  const STEP = 10;
  const moreTaps = new Map();
  function cappedRows(laneId, cards) {
    const lastOpen = cards.findLastIndex((it) => state.openItems.has(it.key));
    const shown = Math.max(STEP * (1 + (moreTaps.get(laneId) || 0)), lastOpen + 1);
    const left = cards.length - shown;
    return cards.slice(0, shown).map((it) => B.card(it)).join('')
      + (left > 0 ? `<button type="button" class="thread-more" data-lane-more="${laneId}">Show more <span class="n">· ${left} older card${left === 1 ? '' : 's'}</span></button>` : '');
  }

  // A fold's open state lives in storage, not in setHTML's summary-text match, because its row's count changes.
  // Fold ids are wave:<slug> (board/domain.mjs waveFold), so any id maps to its own storage key.
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

  // docs/adr/0176-each-board-reviews-incoming-prs-that-touch-its-work.md: the Auto Review lane leads the lanes. The PRs
  // the owner has open are kept in memory, as cards are; answering is the held review whose Post it or Skip is out.
  const openReviews = new Set();
  let answering = null;
  const reviewsHtml = (d) => BoardUI.reviewLane(d.reviews, { answering,
    open: { lane: store.get('lanes', {}).reviews, earlier: store.get(FOLDS['reviews-earlier'].store, false), cards: openReviews } });
  // Opens PR number's review and its lane or fold, for a Needs you line or a push's #review=<number>.
  function openReview(number) {
    openReviews.add(number);
    const s = store.get('lanes', {}); s.reviews = true; store.set('lanes', s);
    if (state.board?.reviews?.earlier.some((c) => c.number === number)) store.set(FOLDS['reviews-earlier'].store, true);
    B.render();
    $(`[data-review="${number}"]`)?.scrollIntoView({ block: 'start' });
  }

  // shown is the board's items after the wave filter and pending deletes.
  function lanesHtml(d, shown) {
    const laneState = store.get('lanes', {});
    return reviewsHtml(d) + LANES.map((lane) => {
      // Items arrive in each lane's fixed order (domain.mjs laneOrder).
      const items = shown.filter((i) => i.lane === lane.id);
      if (lane.hideEmpty && !items.length) return '';
      const expanded = laneState[lane.id] ?? lane.open;
      const open = items.filter((i) => !i.fold);
      const rows = (lane.capped ? cappedRows(lane.id, open) : open.map((it) => B.card(it)).join('')) + waveFolds(d, items);
      return `<details class="lane" data-lane="${lane.id}" ${expanded ? 'open' : ''}>
        <summary><span class="lane-name">${lane.name}</span><span class="count">${items.length}</span>${lane.id === 'review' ? B.githubHeader(d) : ''}</summary>
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
  const showWave = (slug) => { state.waveFilter = slug; store.set('wave', slug); B.render(); };

  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (el.matches?.('details.lane')) {
      const s = store.get('lanes', {}); s[el.dataset.lane] = el.open; store.set('lanes', s);
    } else if (el.matches?.('details.fold')) store.set(FOLDS[el.dataset.fold].store, el.open);
    else if (el.matches?.('details.rv-card, details.rv-line')) {
      if (el.open) openReviews.add(Number(el.dataset.review)); else openReviews.delete(Number(el.dataset.review));
    }
  }, true);

  B.on(B.root, 'click', async (ev) => {
    const answer = ev.target.closest('button[data-review-answer]');
    if (answer) {
      if (answering !== null) return;
      answering = Number(answer.dataset.review);
      B.render();
      try { await B.send('review-answer', { pr: answering, answer: answer.dataset.reviewAnswer }); }
      catch { B.notice('Could not send. Is the host awake?'); }
      finally { answering = null; B.render(); }
      return;
    }
    const review = ev.target.closest('a[data-review-open]');
    if (review) { ev.preventDefault(); openReview(Number(review.dataset.reviewOpen)); return; }
    const more = ev.target.closest('[data-lane-more]');
    if (more) { moreTaps.set(more.dataset.laneMore, (moreTaps.get(more.dataset.laneMore) || 0) + 1); B.render(); return; }
    const pb = ev.target.closest('button[data-plan]');
    if (pb) {
      if (!(await B.confirm('Claude triages these Todo cards into one or more waves and asks you about them in Needs you. Nothing is implemented until you answer. Start?'))) return;
      pb.disabled = true;
      try { await B.send('plan-waves', { keys: pb.dataset.plan.split(' ') }); pb.textContent = 'Planning… its questions appear in Needs you'; }
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
      try { await B.send('wave-triage', { [row.kind]: row.slug }); }
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

  Object.assign(B, { FOLDS, lanesHtml, renderWaves, openReview });
});
