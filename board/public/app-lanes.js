// The board view's lanes and the Auto Review lane leading them: each lane's header and cards, Done's Show more, and
// the board filter in the header, all narrowed by the board search (app-search.js). A lane lists its cards plainly: deps order them and
// Related to and Parent group them, on the cards
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
  // docs/adr/2026-11-17-1230-search-also-finds-old-done-tasks-in-the-archive.md
  // While the search has words, the archive's matches (state.found) follow the loaded Done cards, and "n older tasks" counts the
  // matches not yet fetched, not the archive's other cards.
  const { found } = state;
  function doneCards(d, open) {
    const onBoard = new Set(d.items.map((i) => i.key));
    const loaded = [...open, ...archived.cards.filter((c) => !onBoard.has(c.key))].sort((a, b) => String(b.sortAt || '').localeCompare(String(a.sortAt || '')));
    if (!B.searchWords().length) return loaded;
    const held = new Set(loaded.map((c) => c.key));
    return [...loaded, ...found.cards.filter((c) => !onBoard.has(c.key) && !held.has(c.key))];
  }
  // Open Done's paging stops while the search narrows it: the matches page in by Show more's tap alone.
  function doneRows(d, cards) {
    const searching = B.searchWords().length > 0;
    const older = B.linkedTo() ? 0 : searching ? found.left : olderThanBoard(d);
    if (older > 0 && !searching && store.get('lanes', {}).done && shownCount('done', cards) + STEP >= cards.length) preloadOlder();
    return cappedRows('done', cards, older);
  }
  function doneCount(d, items) {
    const onBoard = new Set(d.items.map((i) => i.key));
    const older = olderThanBoard(d);
    return `${items.length + archived.cards.filter((c) => !onBoard.has(c.key)).length + older}`;
  }
  // One page fetch runs at a time: a tap that lands while a preload is out waits on that fetch instead of starting another.
  let fetching = null;
  // A page of /api/done: the archive's next, or while searching the next of the matches (q), past `last`.
  async function donePage(words, last) {
    const params = new URLSearchParams();
    if (last) params.set('before', `${last.sortAt}|${last.key}`);
    if (words.length) params.set('q', words.join(' '));
    const r = await fetch(B.site.url(`api/done${params.size ? `?${params}` : ''}`), { cache: 'no-store' });
    if (!r.ok) throw new Error(`done ${r.status}`);
    return r.json();
  }
  function fetchOlder() {
    fetching ||= (async () => {
      const words = B.searchWords();
      if (words.length) {
        const key = words.join(' ');
        const page = await donePage(words, found.cards.at(-1));
        // The words changed while the page was out: findArchived's own fetch answers them.
        if (found.key === key) { found.cards.push(...page.cards); found.left = page.left; }
        return page.cards.length;
      }
      const page = await donePage([], archived.cards.at(-1));
      archived.cards.push(...page.cards);
      return page.cards.length;
    })().finally(() => { fetching = null; });
    return fetching;
  }
  // Typing fetches the archive's first page of matches, 250 ms after the last keystroke; no words drops them. The old
  // matches stay drawn until the new page comes, the words' own filter keeping out those that no longer match.
  let finding = null;
  function findArchived(words) {
    clearTimeout(finding);
    const key = words.join(' ');
    found.key = key;
    if (!key) { found.cards = []; found.left = 0; return; }
    finding = setTimeout(async () => {
      try {
        const page = await donePage(words);
        if (found.key !== key || !B.alive()) return;
        found.cards = page.cards;
        found.left = page.left;
        B.render();
      } catch { /* the next keystroke or a Show more tap fetches again */ }
    }, 250);
  }
  B.findArchived = findArchived;
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
  const reviewsHtml = (d, words) => BoardUI.reviewLane(d.reviews, { words,
    open: { lane: store.get('lanes', {}).reviews, earlier: store.get(FOLDS['reviews-earlier'].store, false), cards: openReviews } });
  // Opens PR number's review and its lane or fold, for a push's #review=<number>.
  function openReview(number) {
    openReviews.add(number);
    const s = store.get('lanes', {}); s.reviews = true; store.set('lanes', s);
    if (state.board?.reviews?.earlier.some((c) => c.number === number)) store.set(FOLDS['reviews-earlier'].store, true);
    B.render();
    $(`[data-review="${number}"]`)?.scrollIntoView({ block: 'start' });
  }

  // docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
  // The board filter: the header's funnel, beside search, opens its menu of boxes (ui-cards.js FILTER_BOXES), all
  // checked until the owner unchecks one. An unchecked box hides every card it matches, in every lane, boxes
  // overlapping. The funnel has no count: it turns orange while any box is unchecked. The unchecked boxes are kept on
  // this device (store 'boardFilter'); the menu's open state is in memory.
  const FUNNEL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"/></svg>';
  let filterOpen = false;
  const unchecked = () => store.get('boardFilter', []);
  function setFilter(off) {
    store.set('boardFilter', off);
    if (state.board) B.render();
  }
  // Shows only what the boxes ids name: a needs-you push (#show=), a questions link of no card and the pane's chips
  // set it.
  const showOnly = (ids) => setFilter(BoardUI.filterOnly(ids));
  const hiddenByFilter = (it) => BoardUI.filterHides(it, unchecked());
  // A card the filter, the search or a chain keeps off the board: not in the New strip, and matched by an unchecked
  // box, not holding every word searched for, or out of the chain.
  const hiddenOnBoard = (it) => !it.isNew && (hiddenByFilter(it) || !BoardUI.cardMatches(it, B.searchWords())
    || B.linkedKeys()?.has(it.key) === false);
  // Asks before opening a card the filters hide → true once the owner has reset the filter and ended the search and the
  // chain, so the card shows.
  async function resetFilterToShow() {
    if (!(await B.confirm('This task is not currently visible, reset filters?')) || !B.alive()) return false;
    store.set('boardFilter', []);
    B.endSearch();
    B.endLinked();
    return true;
  }
  function renderFilter() {
    const off = unchecked();
    const menu = filterOpen ? `<div class="board-filter-menu" role="group" aria-label="Show on the board">${BoardUI.FILTER_BOXES.map(({ id, name }) =>
      `<button type="button" class="board-filter-box" role="checkbox" aria-checked="${!off.includes(id)}" data-board-filter="${id}"><span class="box"></span>${name}</button>`).join('')}</div>` : '';
    BoardUI.setHTML($('#boardFilter'), `<button type="button" class="ghost icon board-filter${off.length ? ' on' : ''}" aria-label="Filter the board" aria-expanded="${filterOpen}" title="${off.length ? 'Filtered' : 'Filter'}">${FUNNEL}</button>${menu}`);
  }

  // shown is the board's items less pending deletes. A card still New sits in the New strip, not a lane (ui-cards.js
  // newEntries; docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md).
  // docs/adr/2026-11-17-0613-a-search-bar-narrows-the-board-as-you-type.md: while the board search has words, each lane
  // keeps only the cards holding every word, its count reads x of y even at 0, and a folded lane holding a match opens.
  // docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md: while a card's chain narrows the board
  // (app-search.js linkedKeys), each lane keeps only the chain's cards, the search's words narrowing them further, and a
  // lane holding none of them hides, as Auto Review does, its PRs being no card's links. Done shows the chain's Done
  // cards the page holds, with no Show more past them.
  function lanesHtml(d, shown) {
    const laneState = store.get('lanes', {});
    const words = B.searchWords();
    const chain = B.linkedKeys();
    const narrowed = words.length > 0 || chain !== null;
    const kept = (cards) => cards.filter((it) => (!chain || chain.has(it.key)) && (!words.length || BoardUI.cardMatches(it, words)));
    shown = shown.filter((i) => !i.isNew);
    return (chain ? '' : reviewsHtml(d, words)) + LANES.map((lane) => {
      // Items arrive in each lane's fixed order (domain.mjs laneOrder).
      const all = shown.filter((i) => i.lane === lane.id);
      const done = lane.id === 'done';
      const cards = kept((done ? doneCards(d, all) : all).filter((i) => !hiddenByFilter(i)));
      if (chain && !cards.length) return '';
      const total = done ? doneCount(d, all) : all.length;
      const rows = done ? doneRows(d, cards) : lane.capped ? cappedRows(lane.id, cards) : cardsHtml(cards);
      const count = narrowed || (!done && cards.length < all.length) ? `${cards.length} of ${total}` : total;
      const expanded = narrowed && cards.length ? true : laneState[lane.id] ?? lane.open;
      return `<details class="lane" data-lane="${lane.id}" ${expanded ? 'open' : ''}>
        <summary><span class="lane-name">${lane.name}</span><span class="count">${count}</span>${lane.id === 'review' ? B.githubHeader(d) : ''}</summary>
        <div class="list">${rows || (words.length ? '' : '<div class="empty">Nothing here.</div>')}</div>
      </details>`;
    }).join('');
  }

  // A lane or fold the search or a chain opened or shut keeps its own state: their toggles store nothing.
  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if ((B.searchWords().length || B.linkedTo()) && el.matches?.('details.lane, details.new-orchestrator, details.fold')) return;
    if (el.matches?.('details.lane, details.new-orchestrator')) {
      const s = store.get('lanes', {}); s[el.dataset.lane] = el.open; store.set('lanes', s);
    } else if (el.matches?.('details.fold')) store.set(FOLDS[el.dataset.fold].store, el.open);
    else if (el.matches?.('details.rv-card, details.rv-line')) {
      if (el.open) openReviews.add(Number(el.dataset.review)); else openReviews.delete(Number(el.dataset.review));
    }
  }, true);

  // The open menu closes on a click anywhere but the funnel and the menu, and on Escape. The click goes on to what it hit.
  const closeFilter = () => { if (filterOpen) { filterOpen = false; renderFilter(); } };
  B.on(document, 'click', (ev) => { if (!ev.target.closest?.('#boardFilter')) closeFilter(); }, true);
  B.on(document, 'keydown', (ev) => { if (ev.key === 'Escape') closeFilter(); });

  B.on(B.root, 'click', async (ev) => {
    const answer = ev.target.closest('button[data-review-answer]');
    if (answer) {
      // A held review's Post it or Skip goes through the outbox, its row in the New strip until the board has it
      // (docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md).
      const pr = Number(answer.dataset.review);
      const skip = answer.dataset.reviewAnswer === 'skip';
      B.enqueue(undefined, { kind: 'review-answer', fields: { pr, answer: answer.dataset.reviewAnswer }, said: `Review of PR #${pr}: ${skip ? 'Skip' : 'Post it'}` });
      return;
    }
    if (ev.target.closest('button.board-filter')) { filterOpen = !filterOpen; renderFilter(); return; }
    const box = ev.target.closest('[data-board-filter]');
    if (box) {
      const id = box.dataset.boardFilter;
      setFilter(unchecked().includes(id) ? unchecked().filter((x) => x !== id) : [...unchecked(), id]);
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

  Object.assign(B, { FOLDS, lanesHtml, openReview, hiddenOnBoard, resetFilterToShow, renderFilter, showOnly });
});
