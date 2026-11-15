// Work cards on the board view: a card in a lane, its expanded detail, its action row with each button's confirmation or
// Hold's sheet, and opening it. Needs
// app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, store, state, markSeen, seen, toast, links } = B;
  const { esc, escText, ago, unreadCount, workLines, BUILD_PHASES, phaseStrip, phaseMotion, heldUntilWords, holdPicker, linkText, mergeButton, installButton, tryButton, tryWords, waitOn, prName, BUTTON, LINK_ARROW } = BoardUI;

  const mainSheet = $('#mainLogSheet');
  const mainRetry = $('#mainLogRetry');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let postingMain = false;
  let followMainAfter = null;
  let mainState = null;
  // The log lines the sheet shows, as JSON, so a board that brings the same lines leaves the sheet's scroll alone.
  let shownLog = null;
  function mainReason(text = '') {
    $('#mainLogReason').textContent = text;
    $('#mainLogReason').hidden = !text;
  }
  function closeMainLog() {
    if (!mainSheet.open || mainSheet.classList.contains('closing')) return;
    if (reduceMotion.matches) { mainSheet.close(); return; }
    mainSheet.classList.add('closing');
    B.later(180, () => { mainSheet.classList.remove('closing'); mainSheet.close(); });
  }
  // A failing main's log lines ride the board (main.log; docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md), so the
  // sheet draws them from each board that carries them; while main rebuilds it keeps the last ones.
  function paintMainLog(lines) {
    if (JSON.stringify(lines) === shownLog) return;
    shownLog = JSON.stringify(lines);
    const pre = $('#mainLogLines');
    pre.innerHTML = lines.length ? lines.map((line) => esc(line)).join('\n') : 'No log was written.';
    pre.scrollTop = pre.scrollHeight;
  }
  function renderMainLog(main, load = null) {
    if (!mainSheet.open || mainSheet.classList.contains('closing') || !main) return;
    const words = tryWords(main.kind);
    $('#mainLogTitle').textContent = `Main’s ${words.failed.toLowerCase()}`;
    $('#mainLogSource').innerHTML = `<code>${esc(main.script)}</code> stopped at main@<code>${esc(main.sha)}</code> · last lines of <code>data/try/main.log</code>`;
    if (main.log) paintMainLog(main.log);
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
    shownLog = null;
    renderMainLog(state.board.main);
  });
  B.on($('#mainLogClose'), 'click', closeMainLog);
  B.on(mainSheet, 'click', (ev) => { if (BoardUI.onBackdrop(ev, mainSheet)) closeMainLog(); });
  B.atUnmount(BoardUI.swipeToDismiss(mainSheet));
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

  // Main's refresh icon pulls now on every tap or click, spinning until the server answers. A pull that fails opens its
  // reason (a hover pointer also sees it on hover), and a tap anywhere closes it.
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
    if (!pull || pull.running) return;
    state.mainPull = { open: false };
    // Spins until a board shows the pull running or changed (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
    // A pull that brought no commits changes nothing a board shows, so its answer ends the spinner; one that did waits
    // for Main to rebuild.
    const mainFace = (main) => JSON.stringify([main?.pull, main?.sha, main?.state, main?.at]);
    const before = mainFace(state.board.main);
    let nothingPulled = false;
    const send = async () => {
      const response = await fetch(B.site.url('api/try/main/pull'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const out = await response.json();
      if (!response.ok) throw new Error(out.error || 'The hub refused the pull.');
      if (out.error) state.mainPull.open = true;
      nothingPulled = !out.commits;
    };
    const pulling = B.spinUntil(button, { send, shows: () => nothingPulled || mainFace(state.board.main) !== before });
    paintMain();
    try { await pulling; } catch (error) {
      if (B.alive()) toast(error.message || 'Could not pull. Is the host awake?');
    }
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
  // Whether the open sheet came from the card's reply box, whose Hold goes through the thread's outbox.
  let holdInBox = false;
  function openHold(it, inBox) {
    holdInBox = inBox;
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
  // The reply box's Hold shows its line in the thread at once
  // (docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md); the action row's
  // waits while the server records the hold (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
  async function hold(key, choice) {
    closeHold();
    if (holdInBox) { B.enqueue(key, { kind: 'card-hold', fields: { hold: true, for: choice } }); return; }
    const button = $(`button[data-confirm="hold"][data-key="${CSS.escape(key)}"]`);
    const holdFace = () => { const it = cardOf(key); return JSON.stringify([it?.held, it?.heldUntil]); };
    const before = holdFace();
    try { await B.spinUntil(button, { send: () => B.sentHere(key, () => B.send('card-hold', { key, hold: true, for: choice })), shows: () => holdFace() !== before }); }
    catch (e) { B.failed(e); }
  }
  B.on($('#holdClose'), 'click', closeHold);
  B.on(holdSheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, holdSheet)) { closeHold(); return; }
    const chip = ev.target.closest('[data-hold-for]');
    if (chip) { hold(chip.dataset.holdFor, chip.value); return; }
    const input = ev.target.closest('[data-hold-at]');
    if (!input) return;
    holdPicking = input;
    try { input.showPicker(); } catch { /* iOS opens its wheel on the tap itself. */ }
  });
  B.atUnmount(BoardUI.swipeToDismiss(holdSheet));
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
    const pr = it.pr;
    const ctx = links(it.key);
    // docs/adr/2026-11-15-0840-the-open-card-rows-start-at-its-links-and-drop-status-review-and-ci.md: the face above carries the
    // card's state, CI and reviewers, so the rows start at the card links; a row with nothing to say is left out.
    const rows = [];
    // docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md: each link row is comma-separated text links that open their cards, oldest first.
    // Blocked by lists every blocker, a Done one with its done ring, while the footer's "blocked by" names only the unfinished.
    for (const [label, list] of [['Parent', it.parent ? [it.parent] : []], ['Children', it.children], ['Related to', it.related], ['Blocked by', it.blockers], ['Blocks', it.blocks]]) {
      if (list?.length) rows.push([label, list.map(cardLink).join(', ')]);
    }
    // The builder's risk (builder done --risk), its word coloured as its PR's Slack bar.
    if (it.risk) rows.push(['Risk', `<span class="risk tone-${BoardUI.RISK_TONES[it.risk]}">${esc(it.risk)}</span>`]);
    if (pr?.state === 'OPEN' && pr.mergeStateStatus) rows.push(['Merge', esc(pr.mergeStateStatus.toLowerCase())]);
    if (it.branch) rows.push(['Branch', `<code>${esc(it.branch)}</code>`]);
    if (it.commit) rows.push(['Commit', it.commit.url ? `<a href="${esc(it.commit.url)}" target="_blank" rel="noopener"><code>${esc(it.commit.sha)}</code></a>` : `<code>${esc(it.commit.sha)}</code>`]);
    if (it.manualSteps.length) rows.push(['Manual steps', linkText(it.manualSteps.join('; '), ctx)]);
    if (it.next) rows.push(['Next', linkText(it.next, ctx)]);
    const external = [
      // A vscode: link opens a folder on the machine whose browser follows it, so only the host's browser gets a live one; elsewhere it is muted, with a tooltip and a tap toast.
      it.worktree && !state.board.onHost ? `<a aria-disabled="true" title="not on kickflip host" data-tip="not on kickflip host">Open in VS Code</a>` : '',
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

  const cardLink = (l) => BoardUI.taskLink(l.key, l.ref, l.lane, { cls: 'card-link' });
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
    // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
    merge: (it, ref) => (it.mergeReady ? `Merge ${ref}? The board rebases ${it.mergeReady.branch} onto ${it.mergeReady.base} as it is now, reruns the tests if  moved, and lands it.`
      : openPRs(it).length > 1
      ? `Merge ${ref}? Claude squash-merges ${openPRs(it).map(prName).join(', ')} in turn if they are still approved, green and clean.`
      : `Merge ${ref}? Claude squash-merges ${openPRs(it).map(prName).join('')} if it is still approved, green and clean.`),
    'card-build': (it, ref) => (it.blocked
      ? `${it.held ? 'Unhold and implement' : 'Implement'} ${ref} once ${[it.blockedBy.length && `${it.blockedBy.map((d) => d.ref).join(', ')} ${it.blockedBy.length === 1 ? 'is' : 'are'} done`, it.blockedUntil].filter(Boolean).join(' and ')}? It is bumped to the top of Todo until then.`
      : `${it.held ? `Unhold and implement ${ref}?` : `Implement ${ref}?`} Claude starts its implementer now with the notes as they stand.`),
    finish: (it, ref) => (it.ownerStep ? `Done with "${it.ownerStep}"? ${ref} moves to Done and its ticket closes.`
      : `Done ${ref}? It moves to Done and Claude stops work on it.${openPRs(it).length ? ` Its PR${openPRs(it).length > 1 ? 's stay' : ' stays'} open on GitHub.` : it.pushed ? ` Its branch stays on ${it.pushed.host || 'the remote'}.` : ''}`),
    // docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
    reopen: (it, ref) => `Reopen ${ref}? It moves back to Todo, discussing, for you to talk it through again.`,
  };

  const classes = (it, button, base = '') => {
    const names = [base, it.resolvedBy === button && 'resolves'].filter(Boolean).join(' ');
    return names ? ` class="${names}"` : '';
  };
  const actionRow = (kind, html) => (html.trim() ? `<div class="action-row ${kind}">${html}</div>` : '');

  // The reader sheet opens it (app-reader.js); docs/adr/2026-11-05-0830-notes-is-a-button-on-the-hold-row.md.
  const notesButton = (it) => (it.hasNotes ? `<a class="button" href="notes.html?item=${encodeURIComponent(it.key)}">Notes</a>` : '');

  function actions(it) {
    const key = esc(it.key);
    const ask = (act, label, cls = '') => `<button${cls ? ` class="${cls}"` : ''} data-confirm="${act}" data-key="${key}">${label}</button>`;
    const hold = it.kind !== 'work' || !it.holdable ? ''
      : it.held ? ask('resume', 'Unhold', 'unhold') : ask('hold', 'Hold');
    // A Todo card's Done, right of Hold; an In Review card's Done is in its thread box
    // (docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md).
    const close = it.lane === 'todo' && it.finishable ? ask('finish', 'Done', it.resolvedBy === BUTTON.done ? 'resolves' : '') : '';
    // A Todo card's Implement is in its thread box (app-threads.js; docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md).
    return `<div class="actions" data-actions="${key}">${actionRow('workflow', `${hold}${close}${notesButton(it)}${tryButton(it)}${actionButton(it)}${mergeButton(it)}`)}</div>`;
  }

  // board/domain.mjs actionButtonOf picks the button and resolvedBy its colour (docs/adr/2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md).
  // Every prototype round is a question on its card, so this button reaches the prototypes too, Done cards included
  // (docs/adr/2026-11-09-1100-needs-you-button-reaches-the-prototypes.md).
  const ACTION_BUTTONS = {
    [BUTTON.openQuestions]: (it) => `<a${classes(it, BUTTON.openQuestions, 'button')} href="questions.html#${esc(it.questions.first)}" data-questions="${esc(it.questions.first)}">Questions</a>`,
  };
  const actionButton = (it) => ACTION_BUTTONS[it.actionButton]?.(it) || '';

  // Its open questions asked since this browser last opened it are one more unread message: the thread's "N new
  // questions" line (app-threads.js; docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md).
  function card(it) {
    const unseen = (times) => (state.openItems.has(it.key) ? 0 : unreadCount(times, seen[it.key]));
    const unread = unseen(it.othersAt) + Math.min(1, unseen(it.questions?.askedAt));
    return `<details class="item" data-key="${esc(it.key)}" ${state.openItems.has(it.key) ? 'open' : ''}>
          <summary class="work">
            <span class="status ${it.lane}"></span>
            <div class="title-wrap">${workLines(it, { unread })}</div>
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
    const next = new Map(items.map((it) => [it.key, phaseStrip(it)?.done ?? null]));
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

  // A card the owner opens is the URL's selected card. A card restored open on load fires toggle too, so the tap is
  // what counts, not the toggle.
  B.on(B.root, 'click', (ev) => {
    const card = ev.target.closest?.('details.item > summary')?.parentNode;
    if (card && !card.open) B.select({ card: card.dataset.key }, { board: false });
  });

  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item')) return;
    const key = el.dataset.key;
    if (el.open) {
      state.openItems.add(key);
      state.restored.delete(key);
      const it = state.board.items.find((i) => i.key === key) || state.archived.cards.find((i) => i.key === key);
      markSeen(it);
      B.renderBanner(state.board);
      const unread = el.querySelector('summary .card-unread');
      const line = unread?.parentNode;
      const dot = unread && [unread.nextElementSibling, unread.previousElementSibling].find((n) => n?.matches('.sep'));
      dot?.remove();
      unread?.remove();
      if (line && !line.children.length) line.remove();
      if (it && !el.querySelector('.detail')) { el.insertAdjacentHTML('beforeend', detail(it)); }
      // docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md: the board's sync keeps every card's thread, so a card
      // opens from it with no request; one it lacks loads.
      if (state.threadCache.has(key)) B.renderThread(key, state.threadCache.get(key));
      else B.loadThread(key);
    } else {
      state.openItems.delete(key);
    }
    store.set('openItems', [...state.openItems]);
  }, true);

  B.on(B.root, 'click', async (ev) => {
    const log = ev.target.closest('[data-try-log]');
    if (log && state.openItems.has(log.dataset.tryLog)) {
      ev.preventDefault();
      const card = log.closest('details.item');
      card?.querySelector('.thread')?.scrollIntoView({ block: 'start' });
      return;
    }
    const off = ev.target.closest('a[data-tip]');
    if (off) { ev.preventDefault(); toast(off.dataset.tip); return; }
    const kill = ev.target.closest('button[data-try-kill]');
    const button = kill || ev.target.closest('button[data-try]');
    if (!button) return;
    ev.preventDefault();
    if (button.dataset.tip) { toast(button.dataset.tip); return; }
    const key = kill ? kill.dataset.tryKill : button.dataset.try;
    const it = state.board.items.find((i) => i.key === key);
    if (!it) return;
    // A web card's Serve asks the busy host's question in place of its usual confirm, and the hub's own refusal for a
    // busy host or the board's serve cap is a dialog too
    // (docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md).
    const busyAsk = 'The host is busy, start this serve anyway?';
    const web = it.try?.kind === 'web';
    let anyway = !kill && web && it.try?.hostBusy === true;
    const asked = kill ? `Kill ${it.ref}’s serve? Its server stops until you tap Serve.` : anyway ? busyAsk : `${tryWords(it.try?.kind).go} ${it.ref}? The hub runs its build script.`;
    if (!(await B.confirm(asked)) || !B.alive()) return;
    // Serve / Build and Kill spin until a board shows the card's build changed: running, done or stopped
    // (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md). A busy host's question declined, or the
    // serve cap's refusal, ends the tap with nothing for a board to show.
    const tryFace = () => JSON.stringify(cardOf(key)?.try);
    const before = tryFace();
    const post = async () => {
      const r = await fetch(B.site.url(kill ? 'api/try/kill' : 'api/try'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, ...(anyway ? { anyway } : {}) }) });
      return { ok: r.ok, out: await r.json() };
    };
    let ended = null;
    const send = async () => {
      let { ok, out } = await post();
      if (!ok && out.ask === 'busy' && !anyway) {
        if (!(await B.confirm(busyAsk)) || !B.alive()) { ended = { declined: true }; return; }
        anyway = true;
        ({ ok, out } = await post());
      }
      if (!ok && out.ask === 'cap') { ended = { cap: out.error }; return; }
      if (!ok) throw new Error(out.error || (kill ? 'The hub refused the Kill.' : 'The hub refused the build.'));
    };
    try {
      await B.spinUntil(button, { send, shows: () => ended !== null || tryFace() !== before });
      if (ended?.declined) return;
      if (ended?.cap) { await B.notice(ended.cap); return; }
    } catch (error) {
      toast(error.message || (kill ? 'Could not kill it. Is the host awake?' : 'Could not start. Is the host awake?'));
    }
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
    // Spins until a board shows the card bumped or unbumped (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
    const bumped = () => Boolean(cardOf(key)?.bumpedAt);
    const before = bumped();
    try {
      await B.spinUntil(b, { send: () => B.sentHere(key, () => B.send(unbump ? 'card-unbump' : 'card-bump', { key })), shows: () => bumped() !== before });
      toast(unbump ? 'Unbumped' : 'Moved to the top');
    } catch (e) { B.failed(e); }
  });

  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('button[data-confirm]');
    if (!b) return;
    ev.preventDefault();
    confirmTap(b);
  });
  // A data-confirm button's tap: Hold's sheet, or its confirm, then its event. The thread box's Hold, Resume, Done and
  // Reopen come here on ⌥↵ too; theirs go through the thread's outbox, their line in the thread at once and their button
  // free (docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md).
  async function confirmTap(b) {
    const { key, confirm: act } = b.dataset;
    // Read before the confirm takes the focus: a Done tapped with the card's thread field focused keeps the card open,
    // and the page follows it to Done (app-core.js steady anchors on the field).
    const follow = act === 'finish' && document.activeElement?.matches?.('textarea') && document.activeElement.closest('form[data-reply]')?.dataset.reply === key;
    const it = state.board.items.find((i) => i.key === key);
    const inBox = Boolean(b.closest('form[data-reply]'));
    if (it && act === 'hold') { openHold(it, inBox); return; }
    if (!it || !(await B.confirm(CONFIRM[act](it, it.ref)))) return;
    if (inBox) {
      // A Done not followed closes its card at the tap, before the outbox draws the card in Done
      // (docs/adr/2026-11-15-1500-done-moves-its-card-at-the-tap-and-rolls-back-if-refused.md).
      if (act === 'finish' && !follow) closeCard(key);
      B.enqueue(key, { resume: { kind: 'card-hold', fields: { hold: false } }, finish: { kind: 'card-done', ...(follow ? { follow } : {}) }, reopen: { kind: 'card-reopen' } }[act]);
      return;
    }
    // Unhold, Merge (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md), Implement, Done and Reopen
    // wait while the server records them (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
    // Each carries the version of the card it was drawn on, which the board checks the card against.
    const at = { key, ...(it.version ? { version: it.version } : {}) };
    const sent = { resume: ['card-hold', { ...at, hold: false }], merge: ['card-merge', at], 'card-build': ['card-build', at],
      finish: ['card-done', at], reopen: ['card-reopen', at] }[act];
    // Done closes its card once the server answers, before the answer's board lands, or app-core.js steady would
    // anchor it and scroll the page after it into Done (docs/adr/2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md).
    const close = act === 'finish' && !follow ? () => closeCard(key) : null;
    // Each spins until a board shows its change (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md):
    // Unhold the card unheld; Done and Reopen the card in another lane; Merge the card merging, which its markup draws
    // busy (docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md), or gone from In Review. Implement is T-234's.
    const shows = { resume: (c) => !c?.held, finish: (c) => c?.lane !== it.lane, reopen: (c) => c?.lane !== it.lane,
      merge: (c) => !c || c.lane !== 'review' || c.merging }[act];
    const send = () => B.sentHere(key, () => B.send(...sent, close));
    try { await (shows ? B.spinUntil(b, { send, shows: () => shows(cardOf(key)) }) : waitOn(b, send())); } catch (e) { B.failed(e); }
    if (act === 'finish' || act === 'reopen') B.syncSends(key);
  }

  function closeCard(key) {
    const card = $(`details.item[data-key="${CSS.escape(key)}"]`);
    if (card) BoardUI.closeDetails(card);
    state.openItems.delete(key);
    store.set('openItems', [...state.openItems]);
  }

  function cardOf(key) { return state.board.items.find((i) => i.key === key); }

  Object.assign(B, { captureStrips, moveStrips, detail, card, confirmTap, closeCard });
});
