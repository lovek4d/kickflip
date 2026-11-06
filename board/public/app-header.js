// The board view's header and GitHub status: the time since the last change signal or refresh, refresh, the In Review
// header's GitHub line (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md);
// the GitHub mark's Hub links sheet and a new board's setup checklist (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md);
// and the wake: any tap on an asleep board's page, refresh included, asks the hub to resume its session
// (docs/adr/2026-11-03-0313-boards-run-in-the-background-and-the-hub-board-in-tmux.md). Needs app-core.js.
BoardView.part((B) => {
  const { $, state, toast } = B;
  const { statusLine, freshSig, nextFresh, githubLine, remoteLine, linksList, setupCard, checkLanded, githubRefresh, headerControls } = BoardUI;
  // A request no check answers stops showing after this.
  const GITHUB_GIVE_UP = 5 * 60000;

  function renderHeader(d) {
    if (state.githubPending && (checkLanded(d.checks, state.githubPending) || Date.now() - state.githubPending > GITHUB_GIVE_UP)) state.githubPending = null;
    renderStatus();
    $('#setup').hidden = !d.setup;
    $('#setup').innerHTML = setupCard(d.setup);
    if ($('#linksSheet').open) $('#linksList').innerHTML = linksList(d.links);
  }
  // The status line, and the moon right of the title while the owner reads away (hub/presence.mjs ownerTracker).
  const renderStatus = () => {
    $('#status').innerHTML = statusLine(state.fresh?.at, { link: state.link, watcher: state.board?.checks?.watcher, pause: B.pause?.(), waking: state.waking });
    const moon = $('.away-moon');
    const away = Boolean(B.away?.());
    moon.classList.toggle('on', away);
    moon.setAttribute('aria-hidden', String(!away));
  };
  // A board load and its open threads landed; via is ui-header.js nextFresh's.
  function landed(via) {
    state.fresh = nextFresh(state.fresh, { via, at: new Date().toISOString(), sig: freshSig(state.board, state.threadCache, state.openItems) });
    renderStatus();
  }
  B.every(15000, () => { if (!document.hidden) renderStatus(); });
  const githubHeader = (d) => (d.remote ? `<span class="lane-github">${remoteLine(d.remote, { links: d.links })}</span>`
    : `<span class="lane-github">${githubLine(d.checks, { pending: Boolean(state.githubPending), links: d.links })}${githubRefresh(d.checks, state.githubPending)}</span>`);

  // The Hub links sheet: the GitHub mark opens it, from inside the lane's summary, so the tap must not fold the lane.
  const linksSheet = $('#linksSheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function closeLinks() {
    if (!linksSheet.open || linksSheet.classList.contains('closing')) return;
    if (reduceMotion.matches) { linksSheet.close(); return; }
    linksSheet.classList.add('closing');
    B.later(180, () => { linksSheet.classList.remove('closing'); linksSheet.close(); });
  }
  B.on(B.root, 'click', (ev) => {
    if (!ev.target.closest('[data-hub-links]')) return;
    ev.preventDefault();
    if (!state.board || linksSheet.open) return;
    $('#linksList').innerHTML = linksList(state.board.links);
    linksSheet.classList.remove('closing');
    linksSheet.showModal();
  });
  B.on($('#linksClose'), 'click', closeLinks);
  B.on(linksSheet, 'click', (ev) => { if (ev.target === linksSheet) closeLinks(); });
  B.on(linksSheet, 'cancel', (ev) => { ev.preventDefault(); closeLinks(); });
  function askGitHub() {
    state.githubPending = Date.now();
    B.render();
    B.send('check-github', {}).catch(() => { state.githubPending = null; B.render(); toast('Could not ask Claude to check GitHub'); });
  }
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('[data-check-github]');
    if (!b) return;
    ev.preventDefault();
    if (state.link === 'online' && state.board && !state.githubPending) askGitHub();
  });

  // The wake: the header reads waking… from the tap until the board's reload says the hub took it up.
  state.waking = false;
  async function wake() {
    state.waking = true;
    renderStatus();
    try {
      const r = await fetch('/_hub/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: B.route }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `the hub answered ${r.status}`);
      await B.loadBoard();
    } catch (e) { toast(`Couldn't wake this board's session: ${e.message}`); }
    finally { state.waking = false; if (B.alive()) renderStatus(); }
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
  // Offline, the board stays as it was and reads as before; only the header time turns red, and style.css holds the
  // buttons that send from .view-board.offline (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
  function setLink(link) {
    state.link = link;
    if (link !== 'reconnecting') controls.boardSettled = true;
    B.root.classList.toggle('offline', link !== 'online');
    applyControls();
    renderStatus();
  }
  BoardUI.holdSends(B.on, B.root, () => state.link !== 'online');
  const linkUp = () => setLink('online');
  const linkDown = () => { if (state.link !== 'reconnecting') setLink('offline'); };
  B.on($('.nav'), 'click', (ev) => {
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
  B.every(5000, () => { if (state.githubPending && !document.hidden) B.loadBoard(); });

  Object.assign(B, { renderHeader, renderStatus, landed, githubHeader, linkUp, linkDown, headerWired });
});
