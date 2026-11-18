// The board view's header and GitHub status: the time since the last change signal or refresh, refresh, the In Review
// header's GitHub line (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md);
// the GitHub mark's Hub links sheet and a new board's setup checklist (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md);
// and the wake: any tap on an asleep board's page, refresh included, asks the hub to resume its session
// (docs/adr/2026-11-03-0313-boards-run-in-the-background-and-the-hub-board-in-tmux.md); and the board menu the board's
// name opens, with Join in terminal, Settings, Repo review and Pause. Needs app-core.js.
BoardView.part((B) => {
  const { $, state, toast } = B;
  const { statusLine, freshSig, nextFresh, githubLine, remoteLine, linksList, setupCard, pendingCheck, githubRefresh, headerControls } = BoardUI;

  function renderHeader(d) {
    renderStatus();
    renderPrompts();
    $('#setup').hidden = !d.setup;
    $('#setup').innerHTML = setupCard(d.setup);
    if ($('#linksSheet').open) $('#linksList').innerHTML = linksList(d.links);
  }
  // The status line, and the moon right of the title while the owner reads away (hub/presence.mjs ownerTracker).
  const renderStatus = () => {
    $('#status').innerHTML = statusLine(state.fresh?.at, { link: state.link, watcher: state.board?.checks?.watcher, pause: B.pause?.() });
    renderPause(B.pause?.());
    B.renderStart();
    renderJoin();
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
  B.tick(() => { if (!document.hidden) renderStatus(); });
  // thinking… (the New strip too) counts up in place (ui.js recount).
  B.tick(() => { if (!document.hidden) BoardUI.recount(document); }, 2);
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
    renderJoin();
    try {
      const r = await fetch('/_hub/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: B.route }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `the hub answered ${r.status}`);
      await B.loadBoard();
    } catch (e) { toast(`Couldn't wake this board's session: ${e.message}`); }
    finally { state.waking = false; renderJoin(); }
  }
  const wakeOnTap = () => { if (state.board?.checks?.watcher === 'asleep' && !state.waking && state.link === 'online') wake(); };
  B.on(B.root, 'click', wakeOnTap, true);
  B.on(B.root, 'submit', wakeOnTap, true);

  // docs/adr/2026-11-17-1500-the-board-menu-shows-how-to-join-the-orchestrator-in-a-terminal.md
  // The board menu, which the board's name opens, and its Join in terminal sheet (ui-header.js boardMenu, joinSheet). Each
  // repaints with the header's status while open, so a wake, the session's watcher or the link going down shows at once.
  const menu = $('#boardMenu');
  const menuOpen = $('#boardMenuOpen');
  const joinSheet = $('#joinSheet');
  const joinNow = () => BoardUI.joinState(state.board?.join, { watcher: state.board?.checks?.watcher, link: state.link, waking: state.waking });
  // The pause row reads the hub's pause for this board (B.pause): the owner's Pause board is manual 'board'.
  const menuOptions = () => {
    const pause = B.pause?.();
    const a = state.board?.arch;
    return {
      settings: headerControls(controls).settings,
      arch: a ? { running: Boolean(a.last?.running), at: a.last?.at } : null,
      pause: { paused: Boolean(pause?.paused), mine: pause?.manual === 'board', words: BoardUI.pauseUntilWords(pause?.resets_at) },
    };
  };
  function renderJoin() {
    if (!menu.hidden) BoardUI.setHTML(menu, BoardUI.boardMenu(joinNow(), menuOptions()));
    if (joinSheet.open) BoardUI.setHTML($('#joinBody'), BoardUI.joinSheet(state.board?.join, joinNow()));
  }
  // The menu is a popup (popup.js) anchored on the header's brand, the logo and the name, so it drops from the header's
  // edge: a tap outside it and the brand, or Escape, closes it, Escape focusing the name again.
  function showMenu(open) {
    menu.hidden = !open;
    menuOpen.setAttribute('aria-expanded', String(open));
    renderJoin();
    if (open) Popup.open(menu, menuOpen.closest('.brand'), { onClose: menuClosed });
    else Popup.close(menu);
  }
  function menuClosed(escaped) {
    showMenu(false);
    if (escaped) menuOpen.focus();
  }
  B.on(menuOpen, 'click', () => { if (state.board) showMenu(menu.hidden); });
  // Pause board from the menu: the duration chips (HubKit.durationPicker, as Board Settings draws them) in a sheet, and
  // Resume at one tap, each posting {pause} to api/pause (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md).
  const pauseSheet = $('#pauseSheet');
  const pickers = HubKit.durationPickers(B);
  const closePause = () => BoardUI.closeSheet(pauseSheet, B.later);
  async function openPause() {
    pauseSheet.classList.remove('closing');
    BoardUI.setHTML($('#pauseBody'), '<p class="muted small">Loading…</p>');
    BoardUI.openSheet(pauseSheet);
    try {
      const r = await fetch(B.site.url('api/settings'), { headers: { accept: 'application/json' } });
      const { pause_choices: choices } = await r.json();
      if (!B.alive() || !pauseSheet.open) return;
      const now = Date.now();
      const until = (ms) => BoardUI.pauseUntilWords(ms === null ? 'forever' : new Date(now + ms).toISOString());
      $('#pauseBody').innerHTML = HubKit.durationPicker({ id: 'pauseMenu', title: 'Pause board', icon: '', action: B.site.url('api/pause'), name: 'pause', button: 'Resume',
        choices: choices.map((c) => ({ value: c.value, label: c.label, until: until(c.ms) })) });
      pickers.painted();
    } catch { if (B.alive()) $('#pauseBody').textContent = 'Could not load the choices. Is the host awake?'; }
  }
  async function sendPause(pause, said) {
    try {
      const r = await fetch(B.site.url('api/pause'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pause }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save. Is the host awake?');
      if (!B.alive()) return;
      toast(said);
      await B.loadBoard();
    } catch (e) { if (B.alive()) toast(e.message); }
  }
  B.on(menu, 'click', (ev) => {
    const hit = (sel) => ev.target.closest(sel);
    if (hit('[aria-disabled="true"]')) { ev.preventDefault(); return; }
    if (!hit('[data-join-open], #settingsLink, [data-arch-sheet], [data-pause-open], [data-pause-resume]')) return;
    showMenu(false);
    if (hit('[data-join-open]')) {
      joinSheet.classList.remove('closing');
      BoardUI.openSheet(joinSheet);
      renderJoin();
    }
    if (hit('[data-pause-open]')) openPause();
    if (hit('[data-pause-resume]')) sendPause('off', 'Resumed. New work starts again.');
  });
  B.on(pauseSheet, 'click', (ev) => { if (BoardUI.onBackdrop(ev, pauseSheet) || ev.target.closest('#pauseClose')) closePause(); });
  B.on(pauseSheet, 'submit', (ev) => {
    ev.preventDefault();
    const pause = ev.submitter?.value ?? ev.target.querySelector('input[type="hidden"]')?.value;
    closePause();
    sendPause(pause, 'Paused. New work on this board waits.');
  });
  B.atUnmount(BoardUI.swipeToDismiss(pauseSheet));
  B.on(pauseSheet, 'cancel', (ev) => { ev.preventDefault(); closePause(); });
  const closeJoin = () => BoardUI.closeSheet(joinSheet, B.later);
  B.on($('#joinClose'), 'click', closeJoin);
  B.on(joinSheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, joinSheet)) { closeJoin(); return; }
    if (ev.target.closest('[data-join-wake]') && !state.waking) wake();
    if (ev.target.closest('[data-join-copy]')) {
      Promise.resolve().then(() => navigator.clipboard.writeText(state.board.join.command)).then(() => toast('Copied'), () => toast('Couldn’t copy'));
    }
  });
  B.atUnmount(BoardUI.swipeToDismiss(joinSheet));
  B.on(joinSheet, 'cancel', (ev) => { ev.preventDefault(); closeJoin(); });

  state.link = 'online';
  const controls = { wired: false, boardSettled: false, reloading: false };
  function applyControls() {
    const on = headerControls(controls);
    $('#refresh').disabled = !on.refresh;
    $('#refresh').classList.toggle('spinning', on.spin);
    renderJoin();
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
