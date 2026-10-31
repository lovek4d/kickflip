// The board view's header and GitHub status: the time since the last change signal or refresh, refresh, the In Review
// header's GitHub line (docs/adr/0021-the-board-shows-github-checks-and-watcher-health.md);
// the GitHub mark's Hub links sheet and a new board's setup checklist (docs/adr/0040-one-board-registry-for-every-hub-feature.md).
// Needs app-core.js.
BoardView.part((B) => {
  const { $, state, toast } = B;
  const { statusLine, freshSig, nextFresh, githubLine, linksList, setupCard, checkLanded, githubRefresh, headerControls } = BoardUI;
  // A request no check answers stops showing after this.
  const GITHUB_GIVE_UP = 5 * 60000;

  function renderHeader(d) {
    if (state.githubPending && (checkLanded(d.checks, state.githubPending) || Date.now() - state.githubPending > GITHUB_GIVE_UP)) state.githubPending = null;
    renderStatus();
    $('#setup').hidden = !d.setup;
    $('#setup').innerHTML = setupCard(d.setup);
    if ($('#linksSheet').open) $('#linksList').innerHTML = linksList(d.links);
  }
  const renderStatus = () => { $('#status').innerHTML = statusLine(state.fresh?.at, { link: state.link, watcher: state.board?.checks?.watcher }); };
  // A board load and its open threads landed; via is ui-header.js nextFresh's.
  function landed(via) {
    state.fresh = nextFresh(state.fresh, { via, at: new Date().toISOString(), sig: freshSig(state.board, state.threadCache, state.openItems) });
    renderStatus();
  }
  B.every(15000, () => { if (!document.hidden) renderStatus(); });
  const githubHeader = (d) => `<span class="lane-github">${githubLine(d.checks, { pending: Boolean(state.githubPending), links: d.links })}${githubRefresh(d.checks, state.githubPending)}</span>`;

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
    B.site.send('check-github', {}).catch(() => { state.githubPending = null; B.render(); toast('Could not ask Claude to check GitHub'); });
  }
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('[data-check-github]');
    if (!b) return;
    ev.preventDefault();
    if (state.link === 'online' && state.board && !state.githubPending) askGitHub();
  });

  state.link = 'online';
  const controls = { wired: false, boardSettled: false, reloading: false };
  function applyControls() {
    const on = headerControls({ link: state.link, ...controls });
    $('#refresh').disabled = !on.refresh;
    $('#refresh').classList.toggle('spinning', on.spin);
    const gear = $('#settingsLink');
    if (on.settings) { gear.removeAttribute('aria-disabled'); gear.removeAttribute('tabindex'); } else { gear.setAttribute('aria-disabled', 'true'); gear.tabIndex = -1; }
  }
  const headerWired = () => { controls.wired = true; applyControls(); };
  // style.css dims the offline view from .view-board.offline.
  function setLink(link) {
    const was = state.link;
    state.link = link;
    if (link !== 'reconnecting') controls.boardSettled = true;
    const off = link !== 'online';
    B.root.classList.toggle('offline', off);
    if (link === 'offline' && was === 'online') toast('Offline. Use refresh in the header to retry.');
    applyControls();
    renderStatus();
  }
  const linkUp = () => setLink('online');
  const linkDown = () => { if (state.link !== 'reconnecting') setLink('offline'); };
  B.on($('.nav'), 'click', (ev) => {
    if (ev.target.closest('a[aria-disabled="true"]')) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
  // A load can return in milliseconds, so the spin and "Reconnecting…" hold long enough to read.
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

  Object.assign(B, { renderHeader, landed, githubHeader, linkUp, linkDown, headerWired });
});
