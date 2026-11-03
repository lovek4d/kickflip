// Work cards on the board view: a card in a lane, its expanded detail, its action row with each button's confirmation or
// Hold's sheet, and opening it. Needs
// app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, store, state, markSeen, seen, toast, links } = B;
  const { esc, ago, REVIEW, reviewAge, unreadCount, workLines, heldUntilWords, holdPicker, linkText, mergeButton, buildButton, installButton, tryButton, tryWords, BUTTON, LINK_ARROW } = BoardUI;

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
    const busy = postingMain || followMainAfter !== null || main.state === 'running';
    mainRetry.disabled = busy;
    mainRetry.setAttribute('aria-disabled', String(busy));
    mainRetry.classList.toggle('main-log-going', busy);
    mainRetry.innerHTML = busy ? `<span class="try-spin" aria-hidden="true"></span>${esc(words.going)}` : 'Retry';
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

  // Hold's sheet: the shared duration picker in place of a confirm, since a chip is already a deliberate tap
  // (docs/adr/0118-a-card-can-be-held-until-a-time.md). A chip or Custom sends card-hold {key, hold: true, for}.
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
    $('#holdPicker').innerHTML = holdPicker(it.key, state.board.holdChoices || []);
    const input = $('#holdPicker [data-hold-at]');
    const now = Date.now();
    input.min = localInput(new Date(now + 60_000));
    input.max = localInput(new Date(now + 30 * 86_400_000));
    input.value = input.defaultValue = localInput(new Date(now + 3_600_000));
    holdSheet.classList.remove('closing');
    holdSheet.showModal();
    $('#holdTitle').focus({ preventScroll: true });
  }
  async function hold(key, choice) {
    closeHold();
    try { await B.sentHere(key, () => B.send('card-hold', { key, hold: true, for: choice })); }
    catch { toast('Could not hold. Is the host awake?'); }
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
    if (it.status) rows.push(['Status', esc(it.status)]);
    // docs/adr/0156-a-follow-up-is-a-work-card-with-a-parent.md: each link row is a row of labels that open their cards.
    for (const [label, list] of [['Parent', it.parent ? [it.parent] : []], ['Children', it.children], ['Related to', it.related], ['Blocked by', it.blockedBy], ['Waits on it', it.waitsOnIt]]) {
      if (list?.length) rows.push([label, list.map(cardLink).join(' ')]);
    }
    if (it.manualSteps.length) rows.push(['Manual steps', linkText(it.manualSteps.join('; '), ctx)]);
    if (it.next) rows.push(['Next', linkText(it.next, ctx)]);
    // docs/adr/0062-notes-is-a-link-in-the-details-list.md
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
  // (docs/adr/0127-a-board-can-work-on-any-git-remote.md).
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

  const sendingMerge = new Set();
  const sendingBuild = new Set();
  const CONFIRM = {
    resume: (it, ref) => `Unhold ${ref}?${it.heldUntil ? ` It's held until ${heldUntilWords(it.heldUntil)}.` : ''} It can start again once nothing blocks it.`,
    nudge: () => 'Nudge Claude to check this builder?',
    grill: (it, ref) => `Ask Claude for questions about ${ref}?`,
    merge: (it, ref) => `Merge ${ref}? Claude squash-merges #${it.pr?.number} if it is still approved, green and clean.`,
    'card-build': (it, ref) => (it.blockedBy?.length
      ? `${it.held ? 'Unhold and build' : 'Build'} ${ref} once ${it.blockedBy.map((d) => d.ref).join(', ')} ${it.blockedBy.length === 1 ? 'is' : 'are'} done? It waits in In Progress until then.`
      : `${it.held ? `Unhold and build ${ref}?` : `Build ${ref}?`} Claude starts its builder now with the notes as they stand.`),
    finish: (it, ref) => (it.kind === 'ask' ? `Mark this task done? "${it.title}" moves to Done.`
      : `Close ${ref}? It moves to Done and Claude stops work on it.${it.pr?.state === 'OPEN' ? ' Its PR stays open on GitHub.' : it.pushed ? ` Its branch stays on ${it.pushed.host || 'the remote'}.` : ''}`),
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
    return `<div class="actions" data-actions="${key}">${actionRow('workflow', `${mergeButton(it, sendingMerge.has(it.key))}${hold}${actionButton(it)}${tryButton(it)}${buildButton(it, sendingBuild.has(it.key))}`)}</div>`;
  }

  // board/domain.mjs actionButtonOf picks the button and resolvedBy its colour (docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md).
  const ACTION_BUTTONS = {
    [BUTTON.openQuestions]: (it) => `<a${classes(it, BUTTON.openQuestions, 'button')} href="questions.html#${esc(it.questions.first)}">Open questions</a>`,
    [BUTTON.markDone]: (it) => `<button${classes(it, BUTTON.markDone)} data-confirm="finish" data-key="${esc(it.key)}">Mark as done</button>`,
    [BUTTON.grill]: (it) => (it.grilling ? '<button disabled>Writing questions…</button>' : `<button data-confirm="grill" data-key="${esc(it.key)}">Grill</button>`),
  };
  const actionButton = (it) => ACTION_BUTTONS[it.actionButton]?.(it) || '';

  // The latest bump among New cards takes no second bump (docs/adr/0014-a-pending-ask-can-be-deleted-or-bumped.md).
  const latestBump = (it) => Boolean(it.isNew && it.bumpedAt) && !state.board.items.some((i) => i.isNew && (i.bumpedAt || '') > it.bumpedAt);
  function card(it) {
    return `<details class="item" data-key="${esc(it.key)}" ${state.openItems.has(it.key) ? 'open' : ''}>
          <summary class="work">
            <span class="status ${it.lane}"></span>
            <div class="title-wrap">${workLines(it, { unread: state.openItems.has(it.key) ? 0 : unreadCount(it.othersAt, seen[it.key]), top: latestBump(it) })}</div>
          </summary>
          ${state.openItems.has(it.key) ? detail(it) : ''}
        </details>`;
  }

  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item')) return;
    const key = el.dataset.key;
    if (el.open) {
      state.openItems.add(key);
      const it = state.board.items.find((i) => i.key === key);
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
    button.disabled = true;
    try {
      const r = await fetch(B.site.url('api/try'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'The hub refused the build.');
    } catch (error) { toast(error.message || 'Could not start. Is the host awake?'); }
    B.reload();
  });

  // A work card's bump icon bumps it, or unbumps a bumped one, with no confirm
  // (docs/adr/0145-build-on-a-blocked-card-queues-it.md), and the card moves at once
  // (docs/adr/0151-every-owner-tap-the-server-can-apply-draws-at-once.md).
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('button[data-card-bump]');
    if (!b) return;
    ev.preventDefault();
    const key = b.dataset.cardBump;
    const unbump = b.hasAttribute('data-bumped');
    const icon = `button[data-card-bump="${CSS.escape(key)}"]`;
    const sending = B.sentHere(key, () => B.send(unbump ? 'card-unbump' : 'card-bump', { key }, B.drawItem(key, (it) => ({ ...it, bumpedAt: unbump ? null : new Date().toISOString() }))));
    B.fadeBump(icon, !unbump);
    try { await sending; toast(unbump ? 'Unbumped' : 'Moved to the top'); }
    catch { B.fadeBump(icon, unbump); toast(B.FAILED); }
  });

  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('button[data-confirm]');
    if (!b) return;
    ev.preventDefault();
    const { key, confirm: act } = b.dataset;
    const it = state.board.items.find((i) => i.key === key);
    if (it && act === 'hold') { openHold(it); return; }
    if (!it || !(await B.confirm(CONFIRM[act](it, it.ref)))) return;
    if (act === 'resume') {
      try { await B.sentHere(key, () => B.send('card-hold', { key, hold: false })); }
      catch { toast('Could not resume. Is the host awake?'); }
      return;
    }
    // docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md
    if (act === 'merge') {
      sendingMerge.add(key);
      redrawActions(key);
      try { await B.sentHere(key, () => B.send('card-merge', { key })); }
      catch { toast('Could not send. Is the host awake?'); }
      sendingMerge.delete(key);
      redrawActions(key);
      return;
    }
    if (act === 'card-build') {
      sendingBuild.add(key);
      redrawActions(key);
      try { await B.sentHere(key, () => B.send('card-build', { key })); }
      catch { toast('Could not send. Is the host awake?'); }
      sendingBuild.delete(key);
      redrawActions(key);
      return;
    }
    // docs/adr/0106-the-board-applies-the-owners-hold-resume-and-done-at-once.md
    // The card closes first, or app-core.js steady would anchor it and scroll the page after it into Done.
    if (act === 'finish') {
      const card = $(`details.item[data-key="${CSS.escape(key)}"]`);
      if (card) card.open = false;
      try { await B.sentHere(key, () => (it.kind === 'ask' ? B.send('ask-done', { id: it.id }) : B.send('card-done', { key }))); }
      catch { toast('Could not close. Is the host awake?'); }
      B.syncDone(key);
      return;
    }
    const row = $(`.actions[data-actions="${CSS.escape(key)}"]`);
    row?.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    b.disabled = true;
    try {
      if (act === 'nudge') { await B.sentHere(key, () => B.send('builder-nudge', { key })); b.textContent = 'Sent'; toast('Nudge sent'); }
      else { await B.sentHere(key, () => B.send('grill-more', { key })); B.loadThread(key, { force: true }); }
    } catch { redrawActions(key); toast('Could not send. Is the host awake?'); }
  });

  Object.assign(B, { detail, card });
});
