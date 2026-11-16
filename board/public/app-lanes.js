// The board view's lanes and the Auto Review lane leading them: each lane's header and cards, Done's Show more, and
// Todo's filter. A lane lists its cards plainly: deps order them and Related to and Parent group them, on the cards
// (docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md).
// Needs app-core.js and app-cards.js.
BoardView.part((B) => {
  const { $, store, state } = B;
  const { waitOn } = BoardUI;
  const LANES = [
    { id: 'review', name: 'In Review', open: true },
    { id: 'progress', name: 'In Progress', open: true },
    { id: 'todo', name: 'Todo', open: true },
    { id: 'done', name: 'Done', open: false, capped: true },
  ];
  const cardsHtml = (cards) => cards.map((it) => B.card(it)).join('');
  // docs/adr/2026-11-09-1430-answered-asks-fold-into-the-one-done-list.md
  // A capped lane shows STEP cards, and each Show more tap adds STEP more, kept in memory per lane. A card the owner opened
  // this visit stays shown past the cap; one open from before a reload does not (state.restored), and when Show more reaches one past the first STEP it comes in collapsed. Show more says how many are left (docs/adr/2026-10-29-1639-lists-never-cut-silently.md).
  // older is how many cards wait past `cards` in the archive; the tap that would show past `cards` fetches them first.
  const STEP = 10;
  const moreTaps = new Map();
  function shownCount(laneId, cards) {
    const lastOpen = cards.findLastIndex((it) => state.openItems.has(it.key) && !state.restored.has(it.key));
    return Math.max(STEP * (1 + (moreTaps.get(laneId) || 0)), lastOpen + 1);
  }
  function cappedRows(laneId, cards, older = 0) {
    const shown = shownCount(laneId, cards);
    const left = Math.max(0, cards.length - shown);
    // A card open from before a reload that Show more reaches past the first STEP comes in collapsed.
    const closed = cards.slice(STEP, shown).filter((it) => state.restored.has(it.key) && state.openItems.has(it.key));
    if (closed.length) {
      for (const it of closed) state.openItems.delete(it.key);
      store.set('openItems', [...state.openItems]);
    }
    const n = left + (older || 0);
    const words = `${n} older task${n === 1 ? '' : 's'}`;
    const fetches = older !== 0 && shown + STEP > cards.length;
    return cardsHtml(cards.slice(0, shown))
      + (n > 0 ? `<button type="button" class="thread-more" data-lane-more="${laneId}"${fetches ? ' data-fetch' : ''}>Show more <span class="n">· ${words}</span></button>` : '');
  }

  // docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
  // Done shows the board's Done cards, then those paged in from the archive (GET /api/done), 100 a page, newest first.
  // The board says how many the archive holds (doneArchived), so Done's count is the true total before any page is fetched.
  const { archived } = state;
  const olderThanBoard = (d) => Math.max(0, d.doneArchived - archived.cards.filter((c) => !d.items.some((i) => i.key === c.key)).length);
  function doneRows(d, open) {
    const onBoard = new Set(d.items.map((i) => i.key));
    const cards = [...open, ...archived.cards.filter((c) => !onBoard.has(c.key))].sort((a, b) => String(b.sortAt || '').localeCompare(String(a.sortAt || '')));
    const older = olderThanBoard(d);
    if (older > 0 && store.get('lanes', {}).done && shownCount('done', cards) + STEP >= cards.length) preloadOlder();
    return cappedRows('done', cards, older);
  }
  function doneCount(d, items) {
    const onBoard = new Set(d.items.map((i) => i.key));
    const older = olderThanBoard(d);
    return `${items.length + archived.cards.filter((c) => !onBoard.has(c.key)).length + older}`;
  }
  // One page fetch runs at a time: a tap that lands while a preload is out waits on that fetch instead of starting another.
  let fetching = null;
  function fetchOlder() {
    fetching ||= (async () => {
      const last = archived.cards.at(-1);
      const r = await fetch(B.site.url(`api/done${last ? `?before=${encodeURIComponent(`${last.sortAt}|${last.key}`)}` : ''}`), { cache: 'no-store' });
      if (!r.ok) throw new Error(`done ${r.status}`);
      const page = await r.json();
      archived.cards.push(...page.cards);
      return page.cards.length;
    })().finally(() => { fetching = null; });
    return fetching;
  }
  // Open Done fetches its next page as its shown cards come within one STEP of the cards held. A failure shows nothing: the
  // tap that reaches the edge fetches again, with its toast.
  function preloadOlder() {
    if (fetching) return;
    fetchOlder().then((added) => { if (added && B.alive()) B.render(); }, () => {});
  }

  // A fold's open state lives in storage, not in setHTML's summary-text match, because its row's count changes.
  const FOLDS = new Proxy({}, { get: (_, id) => ({ store: `foldOpen:${String(id)}` }) });

  // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md: the Auto Review lane leads the lanes. The PRs
  // the owner has open are kept in memory, as cards are.
  const openReviews = new Set();
  const reviewsHtml = (d) => BoardUI.reviewLane(d.reviews, {
    open: { lane: store.get('lanes', {}).reviews, earlier: store.get(FOLDS['reviews-earlier'].store, false), cards: openReviews } });
  // Opens PR number's review and its lane or fold, for a push's #review=<number>.
  function openReview(number) {
    openReviews.add(number);
    const s = store.get('lanes', {}); s.reviews = true; store.set('lanes', s);
    if (state.board?.reviews?.earlier.some((c) => c.number === number)) store.set(FOLDS['reviews-earlier'].store, true);
    B.render();
    $(`[data-review="${number}"]`)?.scrollIntoView({ block: 'start' });
  }

  // docs/adr/2026-11-12-0600-the-todo-header-has-a-filter.md
  // The Todo header's filter: one box per group of Todo cards, all checked until the owner unchecks one. A card sits under
  // exactly one box, Blocked if blocked, else its phase's, so the boxes partition the lane and unchecking a box hides exactly
  // its cards. Blocked is any block: by tasks, a condition or the owner
  // (docs/adr/2026-11-15-2230-the-owners-hold-is-a-block.md). The unchecked boxes are kept on this device (store 'todoFilter'); the menu's open state is in memory.
  const PHASE_BOXES = { ready: 'ready', staging: 'ready', discussing: 'discussing', new: 'discussing', grilling: 'planning', prototyping: 'planning' };
  const FILTER_BOXES = [['ready', 'Ready'], ['discussing', 'Discussing'], ['planning', 'Planning'], ['blocked', 'Blocked']];
  const filterBoxOf = (it) => it.blocked ? 'blocked' : PHASE_BOXES[it.phase];
  const FUNNEL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></svg>';
  let filterOpen = false;
  const unchecked = () => store.get('todoFilter', []);
  const hiddenByFilter = (it) => unchecked().includes(filterBoxOf(it));
  const filterHtml = () => {
    const off = unchecked();
    const menu = filterOpen ? `<div class="lane-filter-menu" role="group" aria-label="Show in Todo">${FILTER_BOXES.map(([id, name]) =>
      `<button type="button" class="lane-filter-box" role="checkbox" aria-checked="${!off.includes(id)}" data-todo-filter="${id}"><span class="box"></span>${name}</button>`).join('')}</div>` : '';
    return { button: `<button type="button" class="lane-filter${off.length ? ' on' : ''}" aria-label="Filter Todo" aria-expanded="${filterOpen}" title="${off.length ? 'Filtered' : 'Filter'}">${FUNNEL}</button>`, menu };
  };

  // shown is the board's items less pending deletes. A card still New sits in the New strip, not a lane (ui-cards.js
  // newEntries; docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md).
  function lanesHtml(d, shown) {
    const laneState = store.get('lanes', {});
    shown = shown.filter((i) => !i.isNew);
    return reviewsHtml(d) + LANES.map((lane) => {
      // Items arrive in each lane's fixed order (domain.mjs laneOrder).
      const all = shown.filter((i) => i.lane === lane.id);
      const items = lane.id === 'todo' ? all.filter((i) => !hiddenByFilter(i)) : all;
      const filter = lane.id === 'todo' ? filterHtml() : null;
      const expanded = laneState[lane.id] ?? lane.open;
      const rows = lane.id === 'done' ? doneRows(d, items) : lane.capped ? cappedRows(lane.id, items) : cardsHtml(items);
      return `<details class="lane" data-lane="${lane.id}" ${expanded ? 'open' : ''}>
        <summary><span class="lane-name">${lane.name}</span><span class="count">${lane.id === 'done' ? doneCount(d, items) : lane.id === 'todo' && items.length < all.length ? `${items.length} of ${all.length}` : items.length}</span>${lane.id === 'review' ? B.githubHeader(d) : ''}${filter ? filter.button : ''}</summary>
        ${filter ? filter.menu : ''}
        <div class="list">${rows || '<div class="empty">Nothing here.</div>'}</div>
      </details>`;
    }).join('');
  }

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
      // The tapped answer waits, and the review's other answer is disabled, until the server records it.
      const pr = Number(answer.dataset.review);
      try { await waitOn(answer, B.send('review-answer', { pr, answer: answer.dataset.reviewAnswer }), { group: answer.parentNode.querySelectorAll('button') }); }
      catch { B.notice('Could not send. Is the host awake?'); }
      return;
    }
    const filterBtn = ev.target.closest('button.lane-filter');
    if (filterBtn) { ev.preventDefault(); filterOpen = !filterOpen; B.render(); return; }
    const box = ev.target.closest('[data-todo-filter]');
    if (box) {
      const id = box.dataset.todoFilter;
      store.set('todoFilter', unchecked().includes(id) ? unchecked().filter((x) => x !== id) : [...unchecked(), id]);
      B.render();
      return;
    }
    const more = ev.target.closest('[data-lane-more]');
    if (more) {
      if (more.hasAttribute('data-fetch')) {
        try { await waitOn(more, fetchOlder()); } catch { B.toast('Could not load older tasks. Is the host awake?'); return; }
        if (!B.alive()) return;
      }
      moreTaps.set(more.dataset.laneMore, (moreTaps.get(more.dataset.laneMore) || 0) + 1);
      B.render();
    }
  });

  Object.assign(B, { FOLDS, lanesHtml, openReview });
});
