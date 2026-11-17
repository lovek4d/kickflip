// The board view's pane: from 900px, beside the lanes, the surface every sheet opens into (the reader, a card page, a
// card's questions; ui.js openSheet), each staying until closed. Under them, with none open, the landing: the board's
// name, one line, and chips counting what needs the owner, the questions and the ready cards, each setting the board
// filter to show only those (docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md), then the board at a
// glance: its lanes, what's building and what landed today (glanceHtml). Below 900px there is
// no pane, and a sheet opens over the board. A questions URL lands here at every width (shell.js go, focusQuestion).
// Needs app-core.js and app-lanes.js.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc } = BoardUI;

  // The chips in order: the filter box each shows and its words, coloured by AGENTS.md's priority.
  const CHIPS = [['action', 'need you', 'notice'], ['questions', 'questions', 'info'], ['ready', 'ready', 'success']];
  // d: the board; items: its cards as the lanes draw them.
  function renderPane(d, items) {
    const cards = items.filter((it) => !it.isNew);
    const counts = BoardUI.filterCounts(cards);
    const chips = CHIPS.map(([id, words, tone]) => `<button type="button" class="pane-chip ${tone}" data-pane-show="${id}"><b>${counts[id]}</b> ${words}</button>`).join('');
    BoardUI.setHTML($('#boardPane'), `<div class="pane-landing"><h2>${esc(d.title || '')}</h2><p>Open a card to see it here</p><div class="pane-chips">${chips}</div>${glanceHtml(d, cards)}</div>`);
  }

  // docs/adr/2026-11-17-1944-the-pane-landing-shows-the-board-at-a-glance.md
  // The glance under the chips, in three blocks. Lanes: a line per lane in board order, its count the lane header's
  // own (app-lanes.js laneCards), a short breakdown and a mark in the highest colour among its cards; a tap opens the
  // lane and scrolls the board to it. Building: the In Progress cards, red first, then orange, then grey, each colour
  // by when its build started, so a row holds its place while it builds; each reads its phase, its block or its fault,
  // capped at BUILDING_CAP with a +N more line that scrolls to the lane. Landed: the last three cards landed (green) or
  // merged (purple) today on this device's clock, newest first, a Done card's sortAt being when it closed (domain.mjs
  // SORT_AT) and its commit what it landed. A building or landed row selects its card. Building
  // and Landed show the whole board, whatever the filter hides: they are its activity. Each block with nothing to
  // show keeps its heading and one grey line. Rows are keyed by card (ui.js setHTML), so one that stays is untouched;
  // one new since the last paint washes orange in Building and green in Landed for WASH_MS.
  const BUILDING_CAP = 6;
  const LANDED_SHOWN = 3;
  const WASH_MS = 1600;
  const RANK = ['danger', 'notice', 'info', 'success', 'merged', 'quiet'];
  const highest = (tones) => tones.reduce((top, t) => (RANK.indexOf(t) < RANK.indexOf(top) ? t : top), 'quiet');
  const capital = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
  function faultOf(it) {
    if (it.stalled) return 'Stalled';
    if (it.rebaseFailed) return 'Rebase failed';
    if (it.land?.step === 'fault' || it.land?.step === 'worktree-gone') return 'Land failed';
    if (it.refusal) return 'Refused';
    if (it.builder?.loggedOut) return 'Logged out';
    return null;
  }
  // An In Progress card's tone and word.
  function buildState(it) {
    const fault = faultOf(it);
    if (fault) return ['danger', fault];
    if (it.blocked) return ['notice', it.blockedBy?.length ? `Blocked by ${it.blockedBy.map((b) => b.ref).join(', ')}` : 'Blocked'];
    if (it.builder?.pause?.paused) return ['quiet', 'Paused'];
    if (it.waitsOn === 'checking' || (!it.builder && it.orchestrator)) return ['notice', 'Checking'];
    if (it.builder) return ['notice', it.builder.phase ? capital(it.builder.phase) : 'Starting'];
    if (it.land) return ['notice', 'Landing'];
    return ['quiet', 'Stopped'];
  }
  const today = (iso) => Boolean(iso) && new Date(iso).toDateString() === new Date().toDateString();
  const merged = (it) => it.phase === 'merged';
  const landedToday = (it) => it.lane === 'done' && today(it.sortAt) && (Boolean(it.commit) || merged(it));
  const box = (id) => BoardUI.FILTER_BOXES.find((b) => b.id === id).matches;
  // A card's colour on its lane's mark.
  function cardTone(it) {
    if (faultOf(it)) return 'danger';
    if (it.lane === 'progress') return buildState(it)[0];
    if (it.blocked) return 'notice';
    if (it.lane === 'review') return 'info';
    if (it.lane === 'todo' && box('ready')(it)) return 'success';
    if (landedToday(it)) return merged(it) ? 'merged' : 'success';
    return 'quiet';
  }
  const tally = (pairs) => pairs.filter(([n]) => n).map(([n, words]) => `${n} ${words}`).join(' · ');
  function breakdown(laneId, cards) {
    const n = (match) => cards.filter(match).length;
    if (laneId === 'todo') return tally([[n(box('ready')), 'ready'], [n(box('discussing')), 'discussing'], [n(box('blocked')), 'blocked']]);
    if (laneId === 'progress') {
      const kinds = cards.map((it) => {
        const [tone, word] = buildState(it);
        return tone === 'danger' || it.blocked ? 'blocked' : word === 'Landing' ? 'landing' : tone === 'quiet' ? 'paused' : 'building';
      });
      return tally(['building', 'landing', 'blocked', 'paused'].map((kind) => [kinds.filter((k) => k === kind).length, kind]));
    }
    if (laneId === 'review') return tally([[cards.length, 'to review']]);
    return tally([[n(landedToday), 'landed today']]);
  }

  // When each row (block and card key) was first drawn, null before the first paint: rows there then don't wash.
  let firstDrawn = null;
  function washed(rowKeys) {
    const first = firstDrawn === null;
    const now = Date.now();
    const next = new Map(rowKeys.map((k) => [k, first ? 0 : firstDrawn.get(k) ?? now]));
    firstDrawn = next;
    return (k) => now - next.get(k) < WASH_MS;
  }

  const mark = (tone) => `<i class="glance-mark ${tone}"></i>`;
  function glanceHtml(d, items) {
    const lanes = B.LANES.map((lane) => {
      const all = items.filter((it) => it.lane === lane.id);
      const { count } = B.laneCards(d, lane.id, items);
      const empty = count === '0';
      return `<button type="button" class="glance-row glance-lane${empty ? ' empty' : ''}" id="glance-lane-${lane.id}" data-glance-lane="${lane.id}">${mark(highest(all.map(cardTone)))}<span class="glance-text"><span class="glance-name">${lane.name}</span><span class="glance-detail">${esc(breakdown(lane.id, all))}</span></span><span class="glance-end">${count}</span></button>`;
    }).join('');
    const started = (it) => String(it.builder?.at || it.sortAt || '');
    const building = items.filter((it) => it.lane === 'progress').map((it) => ({ it, state: buildState(it) }))
      .sort((a, b) => RANK.indexOf(a.state[0]) - RANK.indexOf(b.state[0]) || started(a.it).localeCompare(started(b.it)));
    const landed = items.filter(landedToday).sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt))).slice(0, LANDED_SHOWN);
    const shownBuilding = building.slice(0, BUILDING_CAP);
    const fresh = washed([...shownBuilding.map(({ it }) => `b:${it.key}`), ...landed.map((it) => `l:${it.key}`)]);
    const row = (block, it, tone, word, cls = '') => `<button type="button" class="glance-row${cls}${fresh(`${block}:${it.key}`) ? ' fresh' : ''}" id="glance-${block}-${esc(it.key)}" data-glance-open="${esc(it.key)}">${mark(tone)}<span class="glance-text"><b>${esc(it.ref || '')}</b>${esc(it.title || '')}</span><span class="glance-end ${tone}">${esc(word)}</span></button>`;
    const more = building.length - shownBuilding.length;
    const buildingRows = shownBuilding.map(({ it, state: [tone, word] }) => row('b', it, tone, word)).join('')
      + (more > 0 ? `<button type="button" class="glance-row glance-more" id="glance-more" data-glance-lane="progress"><span class="glance-text">+${more} more in In Progress</span></button>` : '');
    const landedRows = landed.map((it) => row('l', it, merged(it) ? 'merged' : 'success', `${merged(it) ? 'merged' : 'landed'} ${BoardUI.ago(it.sortAt)}`, ' landed')).join('');
    const none = (words) => `<div class="glance-none">${words}</div>`;
    return `<div class="glance"><h3>Lanes</h3><div class="glance-lanes">${lanes}</div>`
      + `<h3>Building</h3><div class="glance-building">${buildingRows || none('Nothing is building')}</div>`
      + `<h3>Landed</h3><div class="glance-landed">${landedRows || none('Nothing landed today')}</div></div>`;
  }

  B.on(B.root, 'click', (ev) => {
    const chip = ev.target.closest?.('[data-pane-show]');
    if (chip) { B.showOnly([chip.dataset.paneShow]); return; }
    const lane = ev.target.closest?.('[data-glance-lane]');
    if (lane) { B.openLane(lane.dataset.glanceLane); return; }
    const open = ev.target.closest?.('[data-glance-open]');
    if (open) B.select(open.dataset.glanceOpen);
  });

  // The shell's one rule for a questions URL (shell.js go): it shows the board and asks here for the question or topic
  // id, or null for none → false while the board hasn't loaded, so the shell asks again. A card's question or topic
  // opens the card on the board under its questions sheet, which takes the reader's place: it lands on top of it
  // (ui.js openSheet), then the reader closes under it; a card whose questions are all answered just opens. A topic of
  // no card opens its sheet over the board as it is. An id this copy of the board doesn't hold may be newer than it, as
  // a push's can be: the board reloads once, and the shell's retries wait up to WAIT_TRIES for a new copy. An id the new
  // copy doesn't hold either, or none, shows only the Questions filter's cards.
  const WAIT_TRIES = 20;
  let wait = null;
  function focusQuestion(id) {
    if (!state.board) return false;
    const card = BoardUI.cardOfQuestion(state.board, id);
    if (card) B.select(card);
    if (id && B.openQuestionsSheet(id)) { B.closeReader(); return true; }
    if (card) return true;
    if (id) {
      if (wait?.id !== id) { wait = { id, board: state.board, tries: 0 }; B.reload(); }
      if (wait.board === state.board && wait.tries++ < WAIT_TRIES) return false;
    }
    B.showOnly(['questions']);
    return true;
  }

  Object.assign(B, { renderPane, focusQuestion });
});
