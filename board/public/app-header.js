// The board view's header and GitHub status: the time since the last change signal or refresh, refresh, the In Review
// header's GitHub line (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md);
// the GitHub mark's Hub links sheet and a new board's setup checklist (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md);
// the ?, the way to Waiting on you on phone widths (from 900px the pane is beside the lanes and the ? is hidden), with the
// open-question count as its badge (docs/adr/2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md);
// and the wake: any tap on an asleep board's page, refresh included, asks the hub to resume its session
// (docs/adr/2026-11-03-0313-boards-run-in-the-background-and-the-hub-board-in-tmux.md). Needs app-core.js.
BoardView.part((B) => {
  const { $, state, toast } = B;
  const { statusLine, freshSig, nextFresh, githubLine, remoteLine, linksList, setupCard, pendingCheck, githubRefresh, headerControls } = BoardUI;

  function renderHeader(d) {
    renderStatus();
    renderPrompts();
    $('#setup').hidden = !d.setup;
    $('#setup').innerHTML = setupCard(d.setup);
    if ($('#linksSheet').open) $('#linksList').innerHTML = linksList(d.links);
    renderBadge(d);
  }
  // The ? badge counts the rows Waiting on you draws, which an Implement or Done in the outbox drops at once, and an
  // answer in the answer outbox too.
  function renderBadge(d) {
    const open = BoardUI.queueRows(d.queue, BoardUI.cardTopics(d.ownerTopics || [], d.items || []), B.store.get('outbox', []), BoardUI.unsentAnswers(d.owner, B.store)).length;
    const ask = $('#questionsLink');
    const badge = ask.querySelector('.q-badge');
    badge.hidden = !open;
    badge.textContent = open ? String(open) : '';
    ask.setAttribute('aria-label', open ? `Open questions, ${open} open` : 'Open questions');
    B.syncQuestionsLink();
  }
  B.atUnmount(BoardUI.onOutbox(() => { if (state.board) renderBadge(state.board); }));
  // The status line, and the moon right of the title while the owner reads away (hub/presence.mjs ownerTracker).
  const renderStatus = () => {
    $('#status').innerHTML = statusLine(state.fresh?.at, { link: state.link, watcher: state.board?.checks?.watcher, pause: B.pause?.() });
    renderPause(B.pause?.());
    B.renderStart();
    const moon = $('.away-moon');
    const away = Boolean(B.away?.());
    moon.classList.toggle('on', away);
    moon.setAttribute('aria-hidden', String(!away));
  };
  // The hub's pause banner (HubUI.pauseBanner) at the top of the board while the gate pauses or nears its line, its forms
  // posting to the hub. Pause board's own pause has no hub form, so the header's title alone says it.
  const renderPause = (pause) => {
    const el = $('#pauseBanner');
    const html = pause?.manual === 'board' ? '' : HubUI.pauseBanner(pause);
    el.hidden = !html;
    BoardUI.setHTML(el, html);
  };
  B.on($('#pauseBanner'), 'submit', async (ev) => {
    const form = ev.target;
    const action = form.getAttribute('action') || '';
    if (!action.startsWith('/_hub/')) return;
    ev.preventDefault();
    const body = new URLSearchParams(new FormData(form));
    if (ev.submitter?.name) body.append(ev.submitter.name, ev.submitter.value);
    try {
      const r = await fetch(action, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
      if (!r.ok) throw new Error(String(r.status));
      const out = await r.json().catch(() => null);
      if (out?.pause) renderPause(out.pause);
    } catch { toast('Could not reach the hub. Is the host awake?'); }
  });
  // docs/adr/2026-11-16-1930-a-joined-boards-prompts-show-on-the-board.md
  // The board session's pending prompts (domain.mjs withHub's prompts) as the strip under the pause banner
  // (ui-prompts.js promptStrip), answered through prompts.js; an answered row fades until the next board drops it.
  const prompts = PromptAnswers.wire(B, { list: () => state.board?.prompts || [], paint: () => renderPrompts(), notify: toast });
  function renderPrompts() {
    const el = $('#promptStrip');
    const html = BoardUI.promptStrip(state.board?.prompts || [], { state: prompts.state, answered: (p) => !prompts.shows(p) });
    el.hidden = !html;
    BoardUI.setHTML(el, html);
  }
  // A board load and its open threads landed; via is ui-header.js nextFresh's.
  function landed(via) {
    state.fresh = nextFresh(state.fresh, { via, at: new Date().toISOString(), sig: freshSig(state.board, state.threadCache, state.openItems) });
    renderStatus();
  }
  B.every(15000, () => { if (!document.hidden) renderStatus(); }); // poll: status-repaint
  // thinking… and processing... count up in place (ui.js recount).
  B.every(30000, () => { if (!document.hidden) BoardUI.recount(document); }); // poll: recount
  const githubHeader = (d) => (d.remote ? `<span class="lane-github">${remoteLine(d.remote, { links: d.links })}</span>`
    : `<span class="lane-github">${githubLine(d.checks, { links: d.links })}${githubRefresh(d.checks)}</span>`);

  // The Hub links sheet: the GitHub mark opens it, from inside the lane's summary, so the tap must not fold the lane.
  const linksSheet = $('#linksSheet');
  function closeLinks() {
    BoardUI.closeSheet(linksSheet, B.later);
  }
  B.on(B.root, 'click', (ev) => {
    if (!ev.target.closest('[data-hub-links]')) return;
    ev.preventDefault();
    if (!state.board || linksSheet.open) return;
    $('#linksList').innerHTML = linksList(state.board.links);
    linksSheet.classList.remove('closing');
    BoardUI.openSheet(linksSheet);
  });
  B.on($('#linksClose'), 'click', closeLinks);
  B.on(linksSheet, 'click', (ev) => { if (BoardUI.onBackdrop(ev, linksSheet)) closeLinks(); });
  B.atUnmount(BoardUI.swipeToDismiss(linksSheet));
  B.on(linksSheet, 'cancel', (ev) => { ev.preventDefault(); closeLinks(); });
  // The send's answer carries the board with the request on it, which draws the spinner.
  const askGitHub = () => B.send('check-github', {}).catch(() => toast('Could not ask Claude to check GitHub'));
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('[data-check-github]');
    if (!b) return;
    ev.preventDefault();
    if (state.link === 'online' && state.board && !pendingCheck(state.board.checks)) askGitHub();
  });

  // The wake: a tap asks the hub once, and the header reads waking… when the board's reload says (checks.watcher) the hub took it up.
  state.waking = false;
  async function wake() {
    state.waking = true;
    try {
      const r = await fetch('/_hub/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: B.route }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `the hub answered ${r.status}`);
      await B.loadBoard();
    } catch (e) { toast(`Couldn't wake this board's session: ${e.message}`); }
    finally { state.waking = false; }
  }
  // A shared person's tap never wakes the owner's session (shell.js .shared-view).
  const wakeOnTap = () => { if (state.board?.checks?.watcher === 'asleep' && !state.waking && state.link === 'online' && !document.documentElement.classList.contains('shared-view')) wake(); };
  B.on(B.root, 'click', wakeOnTap, true);
  B.on(B.root, 'submit', wakeOnTap, true);

  state.link = 'online';
  const controls = { wired: false, boardSettled: false, reloading: false };
  function applyControls() {
    const on = headerControls(controls);
    $('#refresh').disabled = !on.refresh;
    $('#refresh').classList.toggle('spinning', on.spin);
    const gear = $('#settingsLink');
    if (on.settings) { gear.removeAttribute('aria-disabled'); gear.removeAttribute('tabindex'); } else { gear.setAttribute('aria-disabled', 'true'); gear.tabIndex = -1; }
  }
  const headerWired = () => { controls.wired = true; applyControls(); };
  // Offline, the board stays as it was and reads as before; only the header time turns red
  // (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md). Every button stays live: its tap
  // waits in the outbox as waiting for the host, and goes out once the link is back
  // (docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md).
  function setLink(link) {
    const was = state.link;
    state.link = link;
    if (link !== 'reconnecting') controls.boardSettled = true;
    B.root.classList.toggle('offline', link !== 'online');
    document.documentElement.classList.toggle('link-offline', link === 'offline');
    BoardUI.repaintLogoDot?.();
    applyControls();
    renderStatus();
    if ((was === 'online') !== (link === 'online')) B.linkChanged();
  }
  const linkUp = () => setLink('online');
  const linkDown = () => { if (state.link !== 'reconnecting') setLink('offline'); };
  B.on($('#settingsLink'), 'click', (ev) => {
    if (ev.target.closest('a[aria-disabled="true"]')) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
  // A load can return in milliseconds, so the spin and "reconnecting…" hold long enough to read.
  const RELOAD_MIN = 700;
  async function reloading(load) {
    controls.reloading = true;
    applyControls();
    try { await Promise.all([load(), new Promise((r) => setTimeout(r, RELOAD_MIN))]); }
    finally { controls.reloading = false; applyControls(); }
  }
  async function reconnect() {
    setLink('reconnecting');
    await reloading(() => B.loadBoard({ via: 'refresh' }));
    if (state.link === 'reconnecting') setLink('offline');
  }

  // The header refresh reloads the board and its open threads; only the GitHub ↻ asks Claude to check GitHub.
  // Offline, it retries the board load instead.
  B.on($('#refresh'), 'click', () => {
    if (state.link === 'offline') { reconnect(); return; }
    reloading(() => B.loadBoard({ via: 'refresh' }));
  });

  Object.assign(B, { renderHeader, renderStatus, landed, githubHeader, linkUp, linkDown, headerWired });
});
