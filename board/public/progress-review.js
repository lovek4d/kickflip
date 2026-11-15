// The progress-bar review page (progress-review.html; docs/adr/2026-11-06-0145-every-run-takes-its-lanes-colour.md): the
// board's lanes with one made-up card per progress bar or status line the board draws, each drawn by the real renderer
// (ui-cards.js workLines, ui-sidebar.js startSteps) and its steps read from them (BUILD_PHASES, START_STEPS). Tapping a
// card opens its editor beneath: its name, its lane and its steps' names and order. Each lane has a colour pick. Send
// posts the whole review as one owner ask, the event the + makes, which the orchestrator files as its own card.
(function () {
  const LANES = [['todo', 'Todo'], ['progress', 'In Progress'], ['review', 'In Review']];
  const LANE_NAME = Object.fromEntries(LANES);
  const STEP_SEP = ' › ';
  const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

  // Each bar or line: the lane it shows in, when, its steps (none for a status line) and the card fields that make the
  // real renderer draw it there.
  function entries() {
    const { BUILD_PHASES, START_STEPS } = BoardUI;
    const build = () => [...BUILD_PHASES];
    return [
      { id: 'grill', name: 'Grilling', lane: 'todo', when: 'A grill planner reads a Todo task and asks its questions', steps: [],
        card: { phase: 'grilling', builder: { planner: true, kind: 'grill', progress: 'Grilling · the notes', phase: null, at: ago(2) } } },
      { id: 'prototype', name: 'Prototyping', lane: 'todo', when: 'A prototype planner draws a Todo task’s takes', steps: [],
        card: { phase: 'prototyping', builder: { planner: true, kind: 'prototype', progress: 'Prototyping · the takes', phase: null, at: ago(2) } } },
      { id: 'build', name: 'Build', lane: 'progress', when: 'A builder works the task, step by step', steps: build(),
        card: { builder: { progress: 'Building · the limiter', phase: 'building', at: ago(2) } } },
      { id: 'check', name: 'Orchestrator review', lane: 'progress', when: 'The orchestrator checks the builder’s calls, on step 3', steps: build(),
        card: { waitsOn: 'checking' } },
      { id: 'install', name: 'Install', lane: 'progress', when: 'The install builder runs; the task keeps the step its build reached', steps: build(),
        card: { builder: { kind: 'install', progress: 'Installing on the phone', phase: null, at: ago(1) }, reachedPhase: 'landing' } },
      { id: 'start', name: 'Board start', lane: 'progress', when: 'A new board clones, starts its orchestrator and lands, in the sidebar', steps: Object.values(START_STEPS),
        start: { step: 'starting', stepAt: ago(0.5) } },
      { id: 'rebase', name: 'Rebase run', lane: 'review', when: 'A PR conflicts with main and the board rebases it', steps: [],
        card: { builder: { progress: 'Rebasing onto main', phase: null, at: ago(1) } } },
      { id: 'merging', name: 'Merging', lane: 'review', when: 'The owner tapped Merge', steps: [], card: { next: 'Merging' } },
      { id: 'stopped', name: 'Land stopped', lane: 'review', when: 'A land stopped short of main', steps: [],
        card: { landStopped: { words: 'Land stopped: CI failed', at: ago(3) } } },
    ].map((e) => ({ ...e, cardLane: e.lane }));
  }

  // A card's markup, as a board card draws it, the entry's step names beneath. The card stays in the lane the board draws
  // it in today (cardLane), so its renderer draws what the board does; the page's lane column only recolours it.
  function cardHtml(e) {
    const { esc, escText, workLines, startSteps, startCaption } = BoardUI;
    const steps = `<div class="line3 sub muted">${e.steps.length ? esc(e.steps.join(STEP_SEP)) : 'a status line, no bar'}</div>`;
    const when = `<div class="line3 sub muted">${escText(e.when)}</div>`;
    if (e.start) {
      return `<div class="line1 title">${escText(e.name)}</div><div class="line3 sub agent">${esc(startCaption(e.start))}</div>${when}${steps}<div class="line6 sub card-time">${startSteps(e.start)}</div>`;
    }
    const card = { kind: 'work', key: `review/${e.id}`, id: e.id, ref: e.id, title: e.name, internal: true, held: false,      deps: [], blockedBy: [], bumpable: false, isNew: false, builder: null, next: null, sortAt: ago(6), ...e.card, lane: e.cardLane };
    return `${workLines(card)}${when}${steps}`;
  }

  // Send's text: every bar with its lane and steps, each change marked with what the board draws now (was).
  // now and was are {entries, colours: {lane: colour}}.
  function reviewText(now, was) {
    const before = Object.fromEntries(was.entries.map((e) => [e.id, e]));
    const changed = (a, b) => (a === b ? a : `${a} (was ${b})`);
    const colours = LANES.map(([lane, name]) => `${name} ${changed(now.colours[lane], was.colours[lane])}`).join(', ');
    const lines = now.entries.map((e) => {
      const b = before[e.id];
      const steps = e.steps.length ? changed(e.steps.join(STEP_SEP), b.steps.join(STEP_SEP)) : 'a status line, no bar';
      return `${changed(e.name, b.name)}, ${changed(LANE_NAME[e.lane], LANE_NAME[b.lane])}: ${steps}`;
    });
    return ['Progress bar review', '', `Lane colours: ${colours}`, '', ...lines].join('\n');
  }

  function mount(root) {
    const { esc } = BoardUI;
    const css = getComputedStyle(document.documentElement);
    const laneColour = { todo: '--muted', progress: '--color-notice', review: '--color-info' };
    const colours = Object.fromEntries(LANES.map(([lane]) => [lane, css.getPropertyValue(laneColour[lane]).trim()]));
    const was = { entries: entries(), colours: { ...colours } };
    const list = entries();
    let open = list[0];
    let dragged = null;

    const lanes = () => `<div class="pr-lanes">${LANES.map(([lane, name]) => `<section class="pr-lane" style="--lane:${esc(colours[lane])}">
      <h2><span>${esc(name)}</span><input type="color" data-colour="${lane}" value="${esc(colours[lane])}" aria-label="${esc(name)} colour"></h2>
      <div class="lane"><div class="list">${list.filter((e) => e.lane === lane).map((e) => `<details class="item" data-entry="${e.id}"${e === open ? ' data-open' : ''}>
        <summary class="work"><span class="status ${e.cardLane}"></span><div class="title-wrap">${cardHtml(e)}</div></summary></details>`).join('') || '<div class="empty">Nothing here</div>'}</div></div>
      </section>`).join('')}</div>`;
    const editor = () => `<section class="pr-editor" aria-label="Edit ${esc(open.name)}"><h2>Editing ${esc(open.name)}</h2>
      <label>Name <input data-name value="${esc(open.name)}"></label>
      <label>Lane <select data-lane>${LANES.map(([lane, name]) => `<option value="${lane}"${lane === open.lane ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
      ${open.steps.length ? `<ol>${open.steps.map((s, k) => `<li draggable="true" data-k="${k}"><span class="grip" aria-hidden="true">⠿</span>
        <input data-step="${k}" value="${esc(s)}" aria-label="Step ${k + 1}">
        <button type="button" class="btn quiet" data-move="${k}" value="-1" aria-label="Move step ${k + 1} earlier"${k ? '' : ' disabled'}>↑</button>
        <button type="button" class="btn quiet" data-move="${k}" value="1" aria-label="Move step ${k + 1} later"${k < open.steps.length - 1 ? '' : ' disabled'}>↓</button></li>`).join('')}</ol>`
        : '<p class="muted">A status line, no steps.</p>'}</section>`;
    root.innerHTML = '<div data-lanes></div><div data-editor></div><div class="pr-send"><button type="button" class="primary" data-send>Send</button><span class="muted" role="status" data-sent></span></div>';
    const drawLanes = () => { root.querySelector('[data-lanes]').innerHTML = lanes(); };
    const draw = () => { drawLanes(); root.querySelector('[data-editor]').innerHTML = editor(); };
    const move = (from, to) => {
      if (to < 0 || to >= open.steps.length) return;
      const [step] = open.steps.splice(from, 1);
      open.steps.splice(to, 0, step);
      draw();
    };
    draw();

    root.addEventListener('click', async (ev) => {
      const summary = ev.target.closest('summary');
      if (summary) {
        ev.preventDefault();
        open = list.find((e) => e.id === summary.parentElement.dataset.entry);
        draw();
        return;
      }
      const b = ev.target.closest('button');
      if (b?.dataset.move !== undefined) { move(Number(b.dataset.move), Number(b.dataset.move) + Number(b.value)); return; }
      if (b?.dataset.send === undefined) return;
      const sent = root.querySelector('[data-sent]');
      b.disabled = true;
      try {
        await ClaudeSite.send('ask', { text: reviewText({ entries: list, colours }, was) });
        sent.textContent = 'Sent. The orchestrator files it as a task.';
      } catch (e) {
        sent.textContent = `Couldn’t send: ${e.reason || e.message}`;
      } finally {
        b.disabled = false;
      }
    });
    // Typing renames on the cards as it goes; the editor itself is redrawn only on a change of lane or order, so it keeps focus.
    root.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.dataset.colour) colours[t.dataset.colour] = t.value;
      else if (t.dataset.name !== undefined) open.name = t.value;
      else if (t.dataset.step) open.steps[Number(t.dataset.step)] = t.value;
      else return;
      drawLanes();
    });
    root.addEventListener('change', (ev) => {
      if (ev.target.dataset.lane === undefined) return;
      open.lane = ev.target.value;
      draw();
    });
    root.addEventListener('dragstart', (ev) => { dragged = ev.target.closest?.('li[data-k]')?.dataset.k ?? null; });
    root.addEventListener('dragover', (ev) => {
      const li = ev.target.closest?.('li[data-k]');
      if (dragged === null || !li) return;
      ev.preventDefault();
      root.querySelectorAll('li.over').forEach((x) => x.classList.toggle('over', x === li));
      li.classList.add('over');
    });
    root.addEventListener('drop', (ev) => {
      const li = ev.target.closest?.('li[data-k]');
      if (dragged === null || !li) return;
      ev.preventDefault();
      const from = Number(dragged);
      dragged = null;
      move(from, Number(li.dataset.k));
    });
    root.addEventListener('dragend', () => { dragged = null; root.querySelectorAll('li.over').forEach((x) => x.classList.remove('over')); });
  }

  globalThis.ProgressReview = { entries, cardHtml, reviewText, mount };
  const root = globalThis.document?.getElementById('review');
  if (root) mount(root);
})();
