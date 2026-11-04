// Work cards on the board view: a card in a lane, its expanded detail, its action row with each button's confirmation or
// Hold's sheet, and opening it. Needs
// app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, store, state, markSeen, seen, toast, links } = B;
  const { esc, ago, REVIEW, reviewAge, unreadCount, workLines, BUILD_PHASES, phaseStrip, phaseMotion, heldUntilWords, holdPicker, linkText, mergeButton, buildButton, installButton, tryButton, tryWords, waitOn, prName, BUTTON, LINK_ARROW } = BoardUI;

  const mainSheet = $('#mainLogSheet');
  const mainRetry = $('#mainLogRetry');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let postingMain = false;
  let followMainAfter = null;
  let mainState = null;
  let logRequest = 0;
  function mainReason(text = '') {
    $('#mainLogReason').textContent = text;
    $('#mainLogReason').hidden = !text;
  }
  function closeMainLog() {
    if (!mainSheet.open || mainSheet.classList.contains('closing')) return;
    logRequest++;
    if (reduceMotion.matches) { mainSheet.close(); return; }
    mainSheet.classList.add('closing');
    B.later(180, () => { mainSheet.classList.remove('closing'); mainSheet.close(); });
  }
  async function loadMainLog() {
    const request = ++logRequest;
    const pre = $('#mainLogLines');
    try {
      const response = await fetch(B.site.url('api/try/main/log'), { cache: 'no-store' });
      const out = await response.json();
      if (!response.ok) throw new Error(out.error || 'Could not read main’s log.');
      if (!B.alive() || request !== logRequest || !mainSheet.open) return;
      pre.innerHTML = out.lines.length ? out.lines.map((line) => esc(line)).join('\n') : 'No log was written.';
      pre.scrollTop = pre.scrollHeight;
    } catch (error) {
      if (B.alive() && request === logRequest && mainSheet.open) mainReason(error.message || 'Could not read main’s log.');
    }
  }
  function renderMainLog(main, load = null) {
    if (!mainSheet.open || mainSheet.classList.contains('closing') || !main) return;
    const words = tryWords(main.kind);
    $('#mainLogTitle').textContent = `Main’s ${words.failed.toLowerCase()}`;
    $('#mainLogSource').innerHTML = `<code>.kickflip/build</code> stopped at main@<code>${esc(main.sha)}</code> · last lines of <code>data/try/main.log</code>`;
    // Only a load begun after the POST resolved can settle this retry.
    const fresh = !postingMain && load !== null && (followMainAfter === null || load >= followMainAfter);
    if (fresh) {
      const followed = followMainAfter !== null || mainState === 'running';
      if (main.state === 'ready' && followed) {
        followMainAfter = null;
        closeMainLog();
        toast(`Main is up again at ${main.sha}.`);
      } else if (main.state === 'failed' && followed) {
        followMainAfter = null;
        mainReason();
        loadMainLog();
      }
      mainState = main.state;
    }
    // Retry waits (ui.js BUSY's look) from the tap until main is up again or its build fails.
    const busy = postingMain || followMainAfter !== null || main.state === 'running';
    mainRetry.disabled = busy;
    if (busy) mainRetry.setAttribute('aria-busy', 'true'); else mainRetry.removeAttribute('aria-busy');
  }
  B.renderMainLog = renderMainLog;
  B.on(B.root, 'click', (ev) => {
    if (!ev.target.closest('[data-main-log]') || !state.board?.main || mainSheet.open) return;
    ev.preventDefault();
    mainReason();
    if (!postingMain) followMainAfter = null;
    mainState = state.board.main.state;
    mainSheet.classList.remove('closing');
    mainSheet.showModal();
    $('#mainLogLines').textContent = 'Loading…';
    renderMainLog(state.board.main);
    loadMainLog();
  });
  B.on($('#mainLogClose'), 'click', closeMainLog);
  B.on(mainSheet, 'click', (ev) => { if (ev.target === mainSheet) closeMainLog(); });
  B.on(mainSheet, 'cancel', (ev) => { ev.preventDefault(); closeMainLog(); });
  B.on(mainRetry, 'click', async () => {
    if (mainRetry.disabled) return;
    postingMain = true;
    mainReason();
    renderMainLog(state.board.main);
    try {
      const response = await fetch(B.site.url('api/try'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'main' }) });
      const out = await response.json();
      if (!response.ok) throw new Error(out.error || 'The hub refused the build.');
      if (!B.alive()) return;
      followMainAfter = B.boardLoad + 1;
    } catch (error) {
      if (B.alive()) mainReason(error.message || 'Could not start. Is the host awake?');
    } finally { postingMain = false; }
    if (B.alive()) {
      renderMainLog(state.board.main);
      B.reload();
    }
  });

  // Main's refresh icon pulls now, spinning until the server answers. After a failed pull, a hover pointer's click
  // pulls again while its reason shows on hover; a touch tap opens the reason instead, and a tap anywhere closes it.
  // An open reason shifts left as far as it would run past the screen's right edge, less the 16px gutter.
  function paintMain() {
    BoardUI.setHTML($('#tryMain'), BoardUI.mainBar(state.board?.main, state.mainPull));
    const why = $('#tryMain .main-pull-why.open');
    if (!why) return;
    const over = why.getBoundingClientRect().right - (innerWidth - 16);
    if (over > 0) why.style.left = `${-over}px`;
  }
  B.on(B.root, 'click', async (ev) => {
    const button = ev.target.closest('button[data-main-pull]');
    if (!button) {
      if (state.mainPull.open) { state.mainPull.open = false; paintMain(); }
      return;
    }
    ev.preventDefault();
    const pull = state.board?.main?.pull;
    if (!pull || pull.running || state.mainPull.sending) return;
    if (pull.error && !matchMedia('(hover: hover)').matches) {
      state.mainPull.open = !state.mainPull.open;
      paintMain();
      return;
    }
    state.mainPull = { sending: true, open: false };
    paintMain();
    try {
      const response = await fetch(B.site.url('api/try/main/pull'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const out = await response.json();
      if (!response.ok) throw new Error(out.error || 'The hub refused the pull.');
    } catch (error) { if (B.alive()) toast(error.message || 'Could not pull. Is the host awake?'); }
    state.mainPull.sending = false;
    if (B.alive()) { paintMain(); B.reload(); }
  });

  // Hold's sheet: the shared duration picker in place of a confirm, since a chip is already a deliberate tap
  // (docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md). A chip or Custom sends card-hold {key, hold: true, for}.
  const holdSheet = $('#holdSheet');
  let holdPicking = null;
  const localInput = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  function closeHold() {
    if (!holdSheet.open || holdSheet.classList.contains('closing')) return;
    holdPicking = null;
    if (reduceMotion.matches) { holdSheet.close(); return; }
    holdSheet.classList.add('closing');
    B.later(180, () => { holdSheet.classList.remove('closing'); holdSheet.close(); });
  }
  function openHold(it) {
    $('#holdTitle').textContent = `Hold ${it.ref}`;
    $('#holdLede').textContent = `${it.lane === 'todo' ? 'It won’t start' : 'Claude stops work on it'} until then. Forever holds it until you unhold it.`;
    const now = Date.now();
    $('#holdPicker').innerHTML = holdPicker(it.key, state.board.holdChoices, new Date(now));
    const input = $('#holdPicker [data-hold-at]');
    input.min = localInput(new Date(now + 60_000));
    input.max = localInput(new Date(now + 30 * 86_400_000));
    input.value = input.defaultValue = localInput(new Date(now + 3_600_000));
    holdSheet.classList.remove('closing');
    holdSheet.showModal();
    $('#holdTitle').focus({ preventScroll: true });
  }
  // The card's Hold waits while the server records the hold (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
  async function hold(key, choice) {
    closeHold();
    const button = $(`button[data-confirm="hold"][data-key="${CSS.escape(key)}"]`);
    try { await waitOn(button, B.sentHere(key, () => B.send('card-hold', { key, hold: true, for: choice }))); }
    catch (e) { B.failed(e); }
  }
  B.on($('#holdClose'), 'click', closeHold);
  B.on(holdSheet, 'click', (ev) => {
    if (ev.target === holdSheet) { closeHold(); return; }
    const chip = ev.target.closest('[data-hold-for]');
    if (chip) { hold(chip.dataset.holdFor, chip.value); return; }
    const input = ev.target.closest('[data-hold-at]');
    if (!input) return;
    holdPicking = input;
    try { input.showPicker(); } catch { /* iOS opens its wheel on the tap itself. */ }
  });
  B.on(holdSheet, 'cancel', (ev) => { ev.preventDefault(); closeHold(); });
  // A chip's pointerdown comes before Custom's focusout; without this reset Custom sends first and the chip's is lost.
  B.on(holdSheet, 'pointerdown', (ev) => {
    if (!ev.target.closest('[data-hold-for]')) return;
    const input = $('#holdPicker [data-hold-at]');
    holdPicking = null;
    if (input) input.value = input.defaultValue;
  });
  // Closing an opened picker accepts its suggested time; an unchanged field reached by Tab sends nothing.
  function holdCustom(input) {
    if (!input.value || (input !== holdPicking && input.value === input.defaultValue) || !input.checkValidity()) return;
    const at = new Date(input.value);
    if (Number.isNaN(at.getTime())) return;
    holdPicking = null;
    input.defaultValue = input.value;
    hold(input.dataset.holdAt, at.toISOString());
  }
  B.on(holdSheet, 'change', (ev) => { if (ev.target.matches?.('[data-hold-at]') && document.activeElement !== ev.target) holdCustom(ev.target); });
  B.on(holdSheet, 'focusout', (ev) => { if (ev.target.matches?.('[data-hold-at]')) holdCustom(ev.target); });

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
    // building is an implementer at work, since Build means the package (docs/adr/2026-11-03-1549-a-todo-cards-button-reads-implement.md).
    if (it.status) rows.push(['Status', esc(it.status === 'building' ? 'implementing' : it.status)]);
    // docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md: each link row is a row of labels that open their cards.
    for (const [label, list] of [['Parent', it.parent ? [it.parent] : []], ['Children', it.children], ['Related to', it.related], ['Blocked by', it.blockedBy], ['Waits on it', it.waitsOnIt]]) {
      if (list?.length) rows.push([label, list.map(cardLink).join(' ')]);
    }
    if (it.manualSteps.length) rows.push(['Manual steps', linkText(it.manualSteps.join('; '), ctx)]);
    if (it.next) rows.push(['Next', linkText(it.next, ctx)]);
    // docs/adr/2026-10-30-1626-notes-is-a-link-in-the-details-list.md
    const external = [
      it.hasNotes ? `<a href="notes.html?item=${encodeURIComponent(it.key)}">Notes ${LINK_ARROW}</a>` : '',
      // A vscode: link opens a folder on the machine whose browser follows it, so only the host's browser gets one.
      it.worktree && state.board.onHost ? `<a href="vscode://file${esc(encodeURI(it.worktree))}" title="Open the worktree in VS Code">Open in VS Code ${LINK_ARROW}</a>` : '',
      installButton(it),
      pr?.state === 'OPEN' ? `<a${classes(it, BUTTON.github)} href="${esc(pr.url)}" target="_blank" rel="noopener">${pr.isDraft ? 'Review draft on GitHub' : 'Review on GitHub'} ${LINK_ARROW}</a>` : '',
      it.pushed ? pushedLink(it) : '',
    ].filter(Boolean);
    const externalRow = external.length ? `<dt class="external-links-label">Links</dt><dd class="external-links">${external.map((html, i) => `<span class="external-link">${i ? '<span class="external-separator" aria-hidden="true"> · </span>' : ''}${html}</span>`).join('')}</dd>` : '';

    return `<div class="detail">
      <dl class="grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}${externalRow}</dl>
      ${actions(it)}
      ${B.thread(it.key)}
    </div>`;
  }

  const cardLink = (l) => `<a class="card-link" href="#item=${encodeURIComponent(l.key)}">${esc(l.ref)}</a>`;
  // A card whose branch is pushed to a plain git remote has no PR to link, so its line copies the branch name
  // (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
  const pushedLink = (it) => `<a href="#" data-copy-branch="${esc(it.pushed.branch)}" title="Copy the branch name">${esc(pushedWords(it))}</a>`;
  const pushedWords = (it) => [`Pushed ${it.ref}${it.pushed.host ? ` to ${it.pushed.host}` : ''}`, it.pushed.at && ago(it.pushed.at)].filter(Boolean).join(' · ');
  B.on(B.root, 'click', (ev) => {
    const link = ev.target.closest('[data-copy-branch]');
    if (!link) return;
    ev.preventDefault();
    navigator.clipboard?.writeText(link.dataset.copyBranch).catch(() => {});
    link.textContent = 'Copied the branch name';
    B.later(1600, () => {
      const it = state.board?.items.find((i) => i.pushed?.branch === link.dataset.copyBranch);
      if (link.isConnected && it) link.textContent = pushedWords(it);
    });
  });

  const openPRs = (it) => (it.prs || []).filter((p) => p.state === 'OPEN');
  const CONFIRM = {
    resume: (it, ref) => `Unhold ${ref}?${it.heldUntil ? ` It's held until ${heldUntilWords(it.heldUntil)}.` : ''} It can start again once nothing blocks it.`,
    nudge: () => 'Nudge Claude to check this implementer?',
    grill: (it, ref) => `Ask Claude for questions about ${ref}?`,
    prototype: (it, ref) => `Ask Claude for prototypes of ${ref}?`,
    merge: (it, ref) => (openPRs(it).length > 1
      ? `Merge ${ref}? Claude squash-merges ${openPRs(it).map(prName).join(', ')} in turn if they are still approved, green and clean.`
      : `Merge ${ref}? Claude squash-merges ${openPRs(it).map(prName).join('')} if it is still approved, green and clean.`),
    'card-build': (it, ref) => (it.blockedBy?.length
      ? `${it.held ? 'Unhold and implement' : 'Implement'} ${ref} once ${it.blockedBy.map((d) => d.ref).join(', ')} ${it.blockedBy.length === 1 ? 'is' : 'are'} done? It waits in In Progress until then.`
      : `${it.held ? `Unhold and implement ${ref}?` : `Implement ${ref}?`} Claude starts its implementer now with the notes as they stand.`),
    finish: (it, ref) => (it.kind === 'ask' ? `Mark this task done? "${it.title}" moves to Done.`
      : it.ownerStep ? `Done with "${it.ownerStep}"? ${ref} moves to Done and its ticket closes.`
      : `Close ${ref}? It moves to Done and Claude stops work on it.${openPRs(it).length ? ` Its PR${openPRs(it).length > 1 ? 's stay' : ' stays'} open on GitHub.` : it.pushed ? ` Its branch stays on ${it.pushed.host || 'the remote'}.` : ''}`),
  };

  const classes = (it, button, base = '') => {
    const names = [base, it.resolvedBy === button && 'resolves'].filter(Boolean).join(' ');
    return names ? ` class="${names}"` : '';
  };
  const actionRow = (kind, html) => (html.trim() ? `<div class="action-row ${kind}">${html}</div>` : '');

  function actions(it) {
    const key = esc(it.key);
    const ask = (act, label, cls = '') => `<button${cls ? ` class="${cls}"` : ''} data-confirm="${act}" data-key="${key}">${label}</button>`;
    const hold = it.kind !== 'work' || !it.holdable ? ''
      : it.held ? (it.buildable ? '' : ask('resume', 'Unhold', 'unhold')) : ask('hold', 'Hold');
    return `<div class="actions" data-actions="${key}">${actionRow('workflow', `${mergeButton(it)}${hold}${actionButton(it)}${tryButton(it)}${buildButton(it)}`)}</div>`;
  }

  // board/domain.mjs actionButtonOf picks the button and resolvedBy its colour (docs/adr/2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md).
  const ACTION_BUTTONS = {
    [BUTTON.openQuestions]: (it) => `<a${classes(it, BUTTON.openQuestions, 'button')} href="questions.html#${esc(it.questions.first)}">Open questions</a>`,
    [BUTTON.markDone]: (it) => `<button${classes(it, BUTTON.markDone)} data-confirm="finish" data-key="${esc(it.key)}">Mark as done</button>`,
    // Grill and Prototype each ask for a planner; both wait while either is under way.
    [BUTTON.grill]: (it) => ['grill', 'prototype'].map((act) => `<button data-confirm="${act}" data-key="${esc(it.key)}"${it.grilling || it.prototyping ? ' disabled' : ''}>${act === 'grill' ? 'Grill' : 'Prototype'}</button>`).join(''),
  };
  const actionButton = (it) => ACTION_BUTTONS[it.actionButton]?.(it) || '';

  // The latest bump among New cards takes no second bump (docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md).
  const latestBump = (it) => Boolean(it.isNew && it.bumpedAt) && !state.board.items.some((i) => i.isNew && (i.bumpedAt || '') > it.bumpedAt);
  // band {step, actions} draws the card in a wave band (app-lanes.js).
  // Its open questions asked since this browser last opened it count as new, as its messages do.
  function card(it, band = {}) {
    const unseen = (times) => (state.openItems.has(it.key) ? 0 : unreadCount(times, seen[it.key]));
    return `<details class="item" data-key="${esc(it.key)}" ${state.openItems.has(it.key) ? 'open' : ''}>
          <summary class="work">
            <span class="status ${it.lane}"></span>
            <div class="title-wrap">${workLines(it, { unread: unseen(it.othersAt), newQuestions: unseen(it.questions?.askedAt), top: latestBump(it), ...band })}</div>
          </summary>
          ${state.openItems.has(it.key) ? detail(it) : ''}
        </details>`;
  }

  // The phase bars move as a card's reached count changes across redraws
  // (docs/adr/2026-11-03-1850-the-phase-bars-animate-as-a-build-starts-advances-and-ends.md,
  // docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md). phases is each card's last drawn count by
  // key, null for no strip; the first draw only records it, so a loaded board stays still.
  const phases = new Map();
  let drawn = false;
  const PHASE_STEP = 40;
  const play = (el, frames, opts, hold = 'backwards') => el.animate(frames, { fill: hold, easing: 'ease-out', ...opts });
  const GROW = [{ opacity: 0, transform: 'scaleX(0)', transformOrigin: 'left' }, { opacity: 1, transform: 'none', transformOrigin: 'left' }];
  const PHASE_SWEEP = 120;
  // --bar-fill is the strip's fill, the muted one on a dimmed strip (style.css).
  const SWEEP = 'linear-gradient(var(--bar-fill), var(--bar-fill))';
  const sweepFrame = (size) => ({ backgroundColor: 'var(--line)', backgroundImage: SWEEP, backgroundRepeat: 'no-repeat', backgroundPosition: 'left', backgroundSize: size });
  const stripOf = (card) => {
    const bars = card?.querySelector('.card-time .phase-bars');
    return bars && { sep: bars.previousElementSibling?.matches('.sep') ? bars.previousElementSibling : null, bars };
  };
  const cardEl = (key) => $(`details.item[data-key="${CSS.escape(key)}"]`);
  // Before lanes redraw: each drawn strip, kept so a build that ends can still leave.
  function captureStrips() {
    const strips = new Map();
    for (const [key, reached] of phases) {
      const strip = typeof reached === 'number' && stripOf(cardEl(key));
      if (strip) strips.set(key, { sep: strip.sep?.cloneNode(true), bars: strip.bars.cloneNode(true) });
    }
    return strips;
  }
  // Sweeps bars from to before to full, one after another, starting after delay.
  const sweep = (bars, from, to, delay) => [...bars.querySelectorAll('i')].slice(from, to)
    .forEach((bar, k) => play(bar, [sweepFrame('0% 100%'), sweepFrame('100% 100%')], { duration: 220, delay: delay + k * PHASE_SWEEP, easing: 'ease-in-out' }));
  // After lanes redraw: compares each card's reached count to its last, then enters, fills or leaves its strip. An
  // entering strip grows in one bar at a time, then sweeps each reached bar.
  function moveStrips(items, before) {
    const next = new Map(items.map((it) => [it.key, phaseStrip(it)?.reached ?? null]));
    const still = reduceMotion.matches || !drawn;
    for (const [key, reached] of next) {
      const kind = still ? null : phaseMotion(phases.get(key), reached);
      if (!kind) continue;
      const strip = stripOf(cardEl(key));
      if (kind === 'leave') {
        const gone = before.get(key);
        const row = cardEl(key)?.querySelector('.card-time');
        if (!gone || !row) continue;
        const bars = [...gone.bars.querySelectorAll('i')].reverse();
        row.append(...[gone.sep, gone.bars].filter(Boolean));
        Promise.all(bars.map((bar, k) => play(bar, [...GROW].reverse(), { duration: 120, delay: k * PHASE_STEP, easing: 'ease-in' }, 'forwards').finished))
          .then(() => play(gone.sep ?? gone.bars, [{ opacity: 1 }, { opacity: 0 }], { duration: 100 }, 'forwards').finished)
          .finally(() => { gone.sep?.remove(); gone.bars.remove(); });
      } else if (strip && kind === 'enter') {
        if (strip.sep) play(strip.sep, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
        [...strip.bars.querySelectorAll('i')].forEach((bar, k) => play(bar, GROW, { duration: 140, delay: 60 + k * PHASE_STEP }));
        sweep(strip.bars, 0, reached, 60 + BUILD_PHASES.length * PHASE_STEP + 140);
      } else if (strip && kind === 'fill') {
        sweep(strip.bars, phases.get(key), reached, 0);
      }
    }
    phases.clear();
    for (const [key, reached] of next) phases.set(key, reached);
    drawn = true;
  }

  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item')) return;
    const key = el.dataset.key;
    if (el.open) {
      state.openItems.add(key);
      const it = state.board.items.find((i) => i.key === key) || state.archived.cards.find((i) => i.key === key);
      markSeen(it);
      const unread = el.querySelector('summary .card-unread');
      const line = unread?.parentNode;
      unread?.remove();
      if (line && !line.children.length) line.remove();
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
    // Serve / Build waits until the hub has started the build; the card's chip then says it runs.
    const post = (async () => {
      const r = await fetch(B.site.url('api/try'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'The hub refused the build.');
    })();
    try { await waitOn(button, post); } catch (error) { toast(error.message || 'Could not start. Is the host awake?'); }
    B.reload();
  });

  // A work card's bump icon bumps it, or unbumps a bumped one, with no confirm
  // (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md). The icon pulses until the server has recorded it, and the card
  // moves as its answer lands (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('button[data-card-bump]');
    if (!b) return;
    ev.preventDefault();
    const key = b.dataset.cardBump;
    const unbump = b.hasAttribute('data-bumped');
    try { await waitOn(b, B.sentHere(key, () => B.send(unbump ? 'card-unbump' : 'card-bump', { key }))); toast(unbump ? 'Unbumped' : 'Moved to the top'); }
    catch (e) { B.failed(e); }
  });

  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('button[data-confirm]');
    if (!b) return;
    ev.preventDefault();
    const { key, confirm: act } = b.dataset;
    const it = state.board.items.find((i) => i.key === key);
    if (it && act === 'hold') { openHold(it); return; }
    if (!it || !(await B.confirm(CONFIRM[act](it, it.ref)))) return;
    // Unhold, Merge (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md), Implement and Done wait while the
    // server records them (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
    const sent = { grill: ['grill-more', { key }], prototype: ['prototype-request', { key }], resume: ['card-hold', { key, hold: false }], merge: ['card-merge', { key }], 'card-build': ['card-build', { key }],
      finish: it.kind === 'ask' ? ['ask-done', { id: it.id }] : ['card-done', { key }] }[act];
    if (sent) {
      // Done closes its card once the server answers, before the answer's board lands, or app-core.js steady would
      // anchor it and scroll the page after it into Done (docs/adr/2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md).
      const close = act === 'finish' ? () => {
        const card = $(`details.item[data-key="${CSS.escape(key)}"]`);
        if (card) BoardUI.closeDetails(card);
        state.openItems.delete(key);
        store.set('openItems', [...state.openItems]);
      } : null;
      try { await waitOn(b, B.sentHere(key, () => B.send(...sent, close))); if (act === 'grill' || act === 'prototype') B.loadThread(key, { force: true }); }
      catch (e) { B.failed(e); }
      if (act === 'finish') B.syncDone(key);
      return;
    }
    // The tapped button waits and the rest of its action row is disabled until the server answers.
    const group = { group: $(`.actions[data-actions="${CSS.escape(key)}"]`)?.querySelectorAll('button') ?? [] };
    try {
      await waitOn(b, B.sentHere(key, () => B.send('builder-nudge', { key })), group); b.disabled = true; toast('Nudge sent');
    } catch { redrawActions(key); toast('Could not send. Is the host awake?'); }
  });

  Object.assign(B, { captureStrips, moveStrips, detail, card });
});
