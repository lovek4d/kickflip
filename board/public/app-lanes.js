// The board view's lanes and the Auto Review lane leading them: each lane's header and cards, Todo's Queued section, Done's and Asks' Show more,
// Done's finished-wave folds, and Todo's wave bands with their Implement, triage and card order.
// Needs app-core.js and app-cards.js.
BoardView.part((B) => {
  const { $, store, state } = B;
  const { esc, waitOn } = BoardUI;
  const LANES = [
    { id: 'review', name: 'In Review', open: true },
    { id: 'stale', name: 'Stale', open: true, hideEmpty: true },
    { id: 'progress', name: 'In Progress', open: true },
    { id: 'todo', name: 'Todo', open: true },
    { id: 'done', name: 'Done', open: false, capped: true },
    { id: 'asks', name: 'Asks', open: false, capped: true },
  ];
  // docs/adr/2026-11-03-0259-answered-asks-have-their-own-section-below-done.md
  // A capped lane shows STEP cards, and each Show more tap adds STEP more, kept in memory per lane. A card the owner has
  // open stays shown past the cap. Show more says how many are left (docs/adr/2026-10-29-1639-lists-never-cut-silently.md).
  // older is how many cards wait past `cards` in the archive; the tap that would show past `cards` fetches them first.
  const STEP = 10;
  const moreTaps = new Map();
  function cappedRows(laneId, cards, older = 0) {
    const lastOpen = cards.findLastIndex((it) => state.openItems.has(it.key));
    const shown = Math.max(STEP * (1 + (moreTaps.get(laneId) || 0)), lastOpen + 1);
    const left = Math.max(0, cards.length - shown);
    const n = left + (older || 0);
    const words = `${n} older card${n === 1 ? '' : 's'}`;
    const fetches = older !== 0 && shown + STEP > cards.length;
    return cards.slice(0, shown).map((it) => B.card(it)).join('')
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
    return cappedRows('done', cards, olderThanBoard(d));
  }
  function doneCount(d, items) {
    const onBoard = new Set(d.items.map((i) => i.key));
    const older = olderThanBoard(d);
    return `${items.length + archived.cards.filter((c) => !onBoard.has(c.key)).length + older}`;
  }
  async function fetchOlder() {
    const last = archived.cards.at(-1);
    const r = await fetch(B.site.url(`api/done${last ? `?before=${encodeURIComponent(`${last.sortAt}|${last.key}`)}` : ''}`), { cache: 'no-store' });
    if (!r.ok) throw new Error(`done ${r.status}`);
    const page = await r.json();
    archived.cards.push(...page.cards);
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

  // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md: the Auto Review lane leads the lanes. The PRs
  // the owner has open are kept in memory, as cards are.
  const openReviews = new Set();
  const reviewsHtml = (d) => BoardUI.reviewLane(d.reviews, {
    open: { lane: store.get('lanes', {}).reviews, earlier: store.get(FOLDS['reviews-earlier'].store, false), cards: openReviews } });
  // Opens PR number's review and its lane or fold, for a Needs you line or a push's #review=<number>.
  function openReview(number) {
    openReviews.add(number);
    const s = store.get('lanes', {}); s.reviews = true; store.set('lanes', s);
    if (state.board?.reviews?.earlier.some((c) => c.number === number)) store.set(FOLDS['reviews-earlier'].store, true);
    B.render();
    $(`[data-review="${number}"]`)?.scrollIntoView({ block: 'start' });
  }

  // shown is the board's items less pending deletes.
  function lanesHtml(d, shown) {
    const laneState = store.get('lanes', {});
    return reviewsHtml(d) + LANES.map((lane) => {
      // Items arrive in each lane's fixed order (domain.mjs laneOrder).
      const items = shown.filter((i) => i.lane === lane.id);
      if (lane.hideEmpty && !items.length) return '';
      const expanded = laneState[lane.id] ?? lane.open;
      const open = items.filter((i) => !i.fold);
      const rows = lane.id === 'todo' ? todoRows(d, shown, open) : (lane.id === 'done' ? doneRows(d, open) : lane.capped ? cappedRows(lane.id, open) : open.map((it) => B.card(it)).join('')) + waveFolds(d, items);
      return `<details class="lane" data-lane="${lane.id}" ${expanded ? 'open' : ''}>
        <summary><span class="lane-name">${lane.name}</span><span class="count">${lane.id === 'done' ? doneCount(d, items) : items.length}</span>${lane.id === 'review' ? B.githubHeader(d) : ''}</summary>
        <div class="list">${rows || '<div class="empty">Nothing here.</div>'}
        ${lane.id === 'todo' ? BoardUI.planButton(items) : ''}</div>
      </details>`;
    }).join('');
  }

  // docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
  // Todo's wave bands (domain.mjs waveBandsOf), then its cards in no wave under Not in a wave. A band's open state lives
  // in storage once the owner taps its head; until then only the first band whose next card is ready (a wave file's:
  // any Todo card) starts open. A band's name shows its goal as a tooltip, or a popover on a long-press. menu is the
  // card whose ⋯ menu is open, goalShown the band whose goal popover is open.
  let menu = null;
  let goalShown = null;
  const triaging = new Set();
  const triageTopic = (r) => `${r.kind}:${r.slug}`;
  function triageLink(r) {
    if (r.triage.running || triaging.has(triageTopic(r))) return '<span class="wv-busy" role="status"><span class="try-spin" aria-hidden="true"></span>triaging…</span>';
    if (r.triage.questions) return `<span class="muted">Triage: ${B.plural(r.triage.questions, 'open question')}</span>`;
    return `<button type="button" class="wv-link" data-triage="${esc(triageTopic(r))}">Triage</button>`;
  }
  const bandStore = (slug) => FOLDS[`band:${slug}`].store;
  const bandOpen = (band, first) => store.get(bandStore(band.slug), band.slug === first);
  const LANE_WORDS = { progress: 'in progress', review: 'in review', stale: 'stale' };
  const DOTS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

  // docs/adr/2026-11-04-0150-queued-sits-at-the-top-of-todo.md
  // Todo's Queued section, which holds the cards waiting for an implementer slot, the next to build on top, as they
  // arrive (domain.mjs laneOrder), then its wave bands and loose cards.
  function todoRows(d, shown, all) {
    const queued = all.filter((i) => i.queued);
    const head = queued.length ? `<div class="wb-loose lane-queue"><div class="wb-head wb-loosehead"><span class="lane-name">Queued</span><span class="count">${queued.length}</span></div>${queued.map((it) => B.card(it)).join('')}</div>` : '';
    return head + bandRows(d, shown, all.filter((i) => !i.queued));
  }

  function bandRows(d, shown, todo) {
    const bands = d.waveBands || [];
    const byKey = new Map(shown.filter((i) => !i.queued).map((i) => [i.key, i]));
    const banded = new Set(bands.flatMap((b) => b.keys));
    const loose = todo.filter((i) => !banded.has(i.key));
    const first = bands.find((b) => (b.next ? b.next.ready : b.keys.some((k) => byKey.get(k)?.ready)))?.slug;
    if (!bands.length) return loose.map((it) => B.card(it)).join('');
    return bands.map((b) => bandHtml(b, b.keys.map((k) => byKey.get(k)).filter(Boolean), bandOpen(b, first))).join('')
      + (loose.length ? `<div class="wb-loose"><div class="wb-head wb-loosehead"><span class="lane-name">Not in a wave</span><span class="count">${loose.length}</span></div>${loose.map((it) => B.card(it)).join('')}</div>` : '');
  }

  function bandHtml(band, cards, open) {
    const todo = cards.filter((i) => i.lane === 'todo');
    const done = cards.filter((i) => i.lane === 'done');
    const now = cards.filter((i) => LANE_WORDS[i.lane]).map((i) => `${esc(i.ref)} ${i.queued ? 'queued' : LANE_WORDS[i.lane]}`);
    const progress = [`${band.merged} of ${band.total} merged`, ...now].join(' · ');
    const name = `<span class="lane-name wb-name"${band.goal ? ` title="${esc(band.goal)}" data-goal="${esc(band.slug)}"` : ''}>${esc(band.title)}</span>`;
    const notes = band.kind === 'lineup' ? `<span class="external-link"><a href="notes.html?wave=${encodeURIComponent(band.slug)}">Notes</a></span><span class="external-separator" aria-hidden="true"> · </span>` : '';
    const next = band.next;
    const go = !next ? '' : next.ready
      ? `<button type="button" class="wv-link" data-confirm="card-build" data-key="${esc(next.key)}">Implement</button>`
      : `<span class="wb-next">next: ${esc(next.ref)} ${esc(next.word)}</span>`;
    const pop = goalShown === band.slug && band.goal ? `<div class="wb-pop" role="tooltip">${esc(band.goal)}</div>` : '';
    const head = `<div class="wb-head" data-band-toggle="${esc(band.slug)}" role="button" tabindex="0" aria-expanded="${open}">${BoardUI.WAVE_ICON}`
      + `<span class="wb-label">${name} <span class="count">${todo.length}</span> <span class="count">· ${progress}</span></span>`
      + `<span class="wb-end"><span class="wb-links">${notes}${triageLink(band)}</span>${go}</span>${pop}</div>`;
    if (!open) return `<section class="wb" data-band="${esc(band.slug)}">${head}</section>`;
    const doneRow = done.length ? `<div class="wb-done">${done.length} done · ${done.map((i) => `<a class="card-link" href="#item=${encodeURIComponent(i.key)}">${esc(i.ref)}</a>`).join(', ')}</div>` : '';
    const step = (it) => (band.kind === 'lineup' ? band.phases.findIndex((p) => p.includes(it.key)) + 1 : 0);
    const actions = (it, at) => (band.kind !== 'lineup' ? null : cardMenu(band.slug, it.key, at, todo.length));
    return `<section class="wb" data-band="${esc(band.slug)}" data-open>${head}<div class="wb-body">${doneRow}${todo.map((it, at) => B.card(it, { step: step(it), actions: actions(it, at) })).join('')}</div></section>`;
  }

  // A lineup card's ⋯ and, while open, its menu: Move up and Move down among the band's Todo cards. A move waits for
  // the server (board/server.mjs lineup-move): the tapped move waits and the other is disabled meanwhile.
  function cardMenu(slug, key, at, count) {
    const shown = menu === key;
    const item = (by, label) => {
      const off = by < 0 ? at === 0 : at === count - 1;
      return `<button type="button" role="menuitem" data-band-move="${by}" data-band="${esc(slug)}" data-key="${esc(key)}"${off ? ' disabled' : ''}>${label}</button>`;
    };
    return `<div class="ask-actions"><button type="button" class="ghost icon wb-dots" data-band-menu="${esc(key)}" aria-label="Card menu" aria-haspopup="menu" aria-expanded="${shown}">${DOTS}</button>`
      + (shown ? `<div class="wb-menu" role="menu">${item(-1, '↑ Move up')}${item(1, '↓ Move down')}</div>` : '') + '</div>';
  }

  // Opens the band holding card key or named slug, for a #item= link or a Needs you line.
  function openBand({ key, slug }) {
    const band = (state.board?.waveBands || []).find((b) => b.slug === slug || b.keys.includes(key));
    if (band) store.set(bandStore(band.slug), true);
    return band;
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
    const review = ev.target.closest('a[data-review-open]');
    if (review) { ev.preventDefault(); openReview(Number(review.dataset.reviewOpen)); return; }
    const more = ev.target.closest('[data-lane-more]');
    if (more) {
      if (more.hasAttribute('data-fetch')) {
        try { await waitOn(more, fetchOlder()); } catch { B.toast('Could not load older cards. Is the host awake?'); return; }
        if (!B.alive()) return;
      }
      moreTaps.set(more.dataset.laneMore, (moreTaps.get(more.dataset.laneMore) || 0) + 1);
      B.render();
      return;
    }
    const pb = ev.target.closest('button[data-plan]');
    if (pb) {
      if (!(await B.confirm('Claude triages these Todo cards into one or more waves and asks you about them in Needs you. Nothing is implemented until you answer. Start?'))) return;
      // Spins until a board shows a grill running on one of the cards (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
      const keys = pb.dataset.plan.split(' ');
      BoardUI.pending.start('todo:plan', (board) => board.items.some((i) => keys.includes(i.key) && i.grilling), B.stillWaiting);
      try {
        const out = await waitOn(pb, B.send('plan-waves', { keys }));
        BoardUI.pending.answered('todo:plan', out.board.generatedAt);
        B.render();
      } catch { BoardUI.pending.drop('todo:plan'); B.render(); B.notice('Could not send. Is the host awake?'); }
      return;
    }
    const tb = ev.target.closest('button[data-triage]');
    if (tb) {
      const topic = tb.dataset.triage;
      const row = state.board.waveBands.find((r) => triageTopic(r) === topic);
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
    const show = ev.target.closest('a[data-band-show]');
    if (show) {
      ev.preventDefault();
      if (!openBand({ slug: show.dataset.bandShow })) return;
      const s = store.get('lanes', {}); s.todo = true; store.set('lanes', s);
      B.render();
      $(`.wb[data-band="${CSS.escape(show.dataset.bandShow)}"]`)?.scrollIntoView({ block: 'start' });
    }
  });

  // A band's ⋯ menu and its moves, its head's fold and its name's goal popover. A long-press on the name (touch only;
  // a mouse has the tooltip) opens the popover, and the click that ends the press neither folds the band nor closes it.
  let press = null;
  let pressed = false;
  const endPress = () => { press?.(); press = null; };
  B.on(B.root, 'pointerdown', (ev) => {
    pressed = false;
    const name = ev.target.closest?.('[data-goal]');
    if (!name || ev.pointerType === 'mouse') return;
    endPress();
    press = B.later(450, () => { press = null; pressed = true; goalShown = name.dataset.goal; B.render(); });
  });
  for (const type of ['pointerup', 'pointercancel']) B.on(B.root, type, endPress);
  B.on(B.root, 'contextmenu', (ev) => { if (ev.target.closest?.('[data-goal]')) ev.preventDefault(); });
  B.on(B.root, 'click', async (ev) => {
    if (pressed) { pressed = false; ev.preventDefault(); return; }
    if (goalShown) { goalShown = null; B.render(); if (ev.target.closest('.wb-head')) return; }
    const dots = ev.target.closest('button[data-band-menu]');
    if (dots) { ev.preventDefault(); menu = menu === dots.dataset.bandMenu ? null : dots.dataset.bandMenu; B.render(); return; }
    const mv = ev.target.closest('button[data-band-move]');
    if (mv) {
      ev.preventDefault();
      if (mv.disabled) return;
      const { band, key } = mv.dataset;
      try { await waitOn(mv, B.send('lineup-move', { lineup: band, key, by: Number(mv.dataset.bandMove) }), { group: mv.parentNode.querySelectorAll('button') }); }
      catch { B.toast('Could not move it. Is the host awake?'); }
      menu = null;
      B.render();
      return;
    }
    if (menu && !ev.target.closest('.wb-menu')) { menu = null; B.render(); if (ev.target.closest('summary')) { ev.preventDefault(); return; } }
    const head = ev.target.closest('[data-band-toggle]');
    if (head && !ev.target.closest('a, button')) {
      const slug = head.dataset.bandToggle;
      store.set(bandStore(slug), head.getAttribute('aria-expanded') !== 'true');
      B.render();
    }
  });
  B.on(B.root, 'keydown', (ev) => {
    const head = ev.target.closest?.('[data-band-toggle]');
    if (head && ev.target === head && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); head.click(); }
  });

  Object.assign(B, { FOLDS, lanesHtml, openReview, openBand });
});
