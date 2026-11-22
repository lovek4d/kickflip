// The board header's time and the In Review header's GitHub line, with when a refresh asks for a check. Needs ui.js.
(function () {
  const { since, esc } = globalThis.BoardUI;
  // The header's short time beside refresh: `at` is when the page last got fresh data (nextFresh). It reads that age;
  // the board's other states only move its title; the logo's dot carries the state, and the span takes `late` past a
  // minute old, which style.css turns orange with the arrow (docs/adr/2026-11-12-1000-the-logo-dot-carries-the-hub-state.md). watcher is
  // /api/board's checks.watcher (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md).
  // link is 'online', 'offline' (the last board load failed) or 'reconnecting' (a refresh tap is retrying it, and the icon spins).
  const statusLine = (at, { link = 'online', watcher, pause } = {}) => {
    const paused = Boolean(pause?.paused);
    const reason = link === 'offline' ? "Offline: can't reach the host"
      : watcher === 'stopped' ? 'Claude not listening'
      : paused ? `Paused ${BoardUI.pauseUntilWords(pause.resets_at)}`
      : link === 'reconnecting' ? 'Reconnecting…'
      : watcher === 'waking' ? 'Waking: the hub is resuming its session'
      : watcher === 'asleep' ? 'Asleep: its session idled out. Refresh, or any tap on the page, wakes it' : '';
    if (!at && !reason) return '';
    const title = [reason, at && `Updated ${since(at)}: the last change from the host, or your last refresh`].filter(Boolean).join('. ');
    const late = at && Date.now() - Date.parse(at) > 60000;
    return `<span class="fresh${late ? ' late' : ''}" title="${esc(title)}">${at ? shortSince(at) : ''}</span>`;
  };
  // What the page shows, for telling whether a change signal brought anything new; generatedAt changes on every load.
  const freshSig = (board, threads, openKeys) => JSON.stringify([{ ...board, generatedAt: null }, [...openKeys].sort().map((k) => [k, threads.get(k) ?? null])]);
  // fresh is {at, sig}: the header's time and what the page showed then. via is 'refresh' (a ↻ tap), 'signal' (the
  // stream's change signal) or 'poll' (any other load). A manual refresh always moves the time, a change signal only when it brought
  // something the time hasn't counted, a poll never, and any load moves it while none has landed (sig null)
  // (docs/adr/2026-10-29-1639-the-board-reloads-on-a-change-signal.md).
  const nextFresh = (fresh, { via, at, sig }) => (!fresh?.sig || via === 'refresh' || (via === 'signal' && sig !== fresh.sig) ? { at, sig } : fresh);
  const shortSince = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 60 ? 'now' : s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' d';
  };
  // GitHub's logo guidelines forbid altering the mark, so it stays filled rather than a line icon (docs/adr/2026-10-29-1639-icons-are-sf-symbol-style-line-icons.md).
  const GITHUB_MARK = '<svg class="gh-mark" width="13" height="13" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="GitHub"><title>GitHub</title><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
  // The GitHub mark opens the Hub links sheet, with a red dot while any link is broken past its grace period
  // (docs/adr/2026-10-29-1639-hub-links-turn-red-only-after-a-grace-period.md). links is /api/board's (hub/boards.mjs linksOf), null
  // when the hub doesn't list this board. A link without state, from a board server still running older code, reads from ok.
  const linkState = (l) => l.state || (l.ok ? 'ok' : 'broken');
  const brokenLinks = (links) => (links || []).filter((l) => linkState(l) === 'broken');
  const linksMark = (links, mark = GITHUB_MARK) => {
    const broken = brokenLinks(links).length;
    const label = `Hub links${broken ? `: ${broken} not working` : ''}`;
    return `<button class="ghost gh-links" type="button" data-hub-links aria-haspopup="dialog" aria-label="${label}" title="${label}">${mark}${broken ? '<span class="links-dot" aria-hidden="true"></span>' : ''}</button>`;
  };
  // A board on a plain git remote has no GitHub checks, so the In Review header names its repo, host/path, instead
  // (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
  const REMOTE_MARK = '<svg class="gh-mark" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/></svg>';
  const remoteLine = (remote, { links = null } = {}) => `<span class="github remote" title="This board’s repo">${linksMark(links, REMOTE_MARK)} <span class="remote-name">${esc(remote.name)}</span></span>`;
  // The In Review header's right end; checks.requested says whether a check-github request is waiting.
  const githubLine = (checks, { links = null } = {}) => {
    const mark = linksMark(links);
    if (pendingCheck(checks)) return `<span class="github">${mark} Checking…</span>`;
    if (!checks?.at) return `<span class="github idle" title="GitHub not checked yet">${mark} not checked</span>`;
    const title = `GitHub checked ${since(checks.at)}${checks.idle ? '; no task shows an open PR' : checks.late ? '; checks are late' : ''}`;
    const note = checks.late && !checks.idle ? ' · checks are late' : '';
    return `<span class="github${checks.late && !checks.idle ? ' late' : ''}${checks.idle ? ' idle' : ''}" title="${title}">${mark} ${shortSince(checks.at)}${note}</span>`;
  };

  const LINK_NAMES = { github: 'GitHub polling', 'repo-fetch': 'Repo fetch', events: 'Events', wakes: 'Daily wakes', slack: 'Reviewer links' };
  // The Hub links sheet's list, one row per link with a green dot, a muted one while settling, or a red one
  // (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md).
  const LINK_DOTS = { ok: ['green', 'Working'], settling: ['grey', 'Settling'], broken: ['red', 'Not working'] };
  const linkRow = (l) => {
    const st = linkState(l);
    const [colour, label] = LINK_DOTS[st] || LINK_DOTS.broken;
    const detail = st === 'settling' ? `Settling: ${l.detail}` : l.detail;
    return `<li>${globalThis.BoardUI.iconText('dot', colour, '', { label })}<span><strong>${esc(LINK_NAMES[l.link] || l.link)}</strong><span class="sub">${esc(detail)}</span></span></li>`;
  };
  const linksList = (links) => (links?.length
    ? `<ul class="hub-links">${links.map(linkRow).join('')}</ul>`
    : '<p class="muted">The hub doesn\'t list this board yet. It picks a board up from the manifest on its next check.</p>');

  // The checklist a new board shows at the top until its session answered the ping and GitHub checks reach it; setup
  // is /api/board's, null once both pass. Cards can start meanwhile.
  const setupCard = (setup) => {
    if (!setup) return '';
    const step = (ok, done, waiting) => `<li>${globalThis.BoardUI.iconText('dot', ok ? 'green' : 'orange', ok ? done : waiting)}</li>`;
    return `<h2>Connecting this board</h2><ul class="setup-steps">
      ${step(setup.events, 'Claude answered the ping', 'Waiting for Claude to answer the ping')}
      ${setup.github === undefined ? '' : step(setup.github, 'GitHub checks reach this board', 'Waiting for the hub\'s next GitHub check')}
    </ul>`;
  };
  // The server's checks.requested says whether a page's check-github request is waiting (domain.mjs checksOf).
  const pendingCheck = (checks) => checks?.requested?.state === 'pending';
  const refreshIcon = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
  // The GitHub line's own refresh, spinning and resting while a request is pending. It sits in the lane's summary, so
  // it is aria-disabled, not disabled: a resting tap must still reach app-header.js's handler, which keeps the lane from folding.
  const githubRefresh = (checks) => `<button class="ghost gh-refresh${pendingCheck(checks) ? ' spinning' : ''}" type="button" data-check-github aria-label="Check GitHub" title="Check GitHub"${pendingCheck(checks) ? ' aria-disabled="true"' : ''}>${refreshIcon(14)}</button>`;

  // Which header controls take taps, and whether refresh spins. The header paints them disabled with refresh spinning;
  // both turn on together once the first board load has answered or failed.
  // Offline, refresh stays on so a tap can retry the load (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md),
  // and Settings opens its read-only copy (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
  const headerControls = ({ wired = false, boardSettled = false, reloading = false } = {}) => {
    const ready = wired && boardSettled && !reloading;
    return { refresh: ready, settings: ready, spin: !boardSettled || reloading };
  };

  // docs/adr/2026-11-17-1500-the-board-menu-shows-how-to-join-the-orchestrator-in-a-terminal.md
  // Join in terminal, in the board menu the board's name opens. join is /api/board's (hub/sessions.mjs joinOf),
  // {command, tmux} or null, which the saved copy holds too. Its state: 'down' while the server doesn't answer (link
  // offline), else by the session's watcher (checks.watcher): 'awake' running, 'asleep', 'waking' (the hub resuming it,
  // or the page's own wake on its way), 'none' with no session yet or one starting, else 'deaf', not listening.
  const joinState = (join, { watcher, link = 'online', waking = false } = {}) => (!join ? 'none'
    : link === 'offline' ? 'down'
    : waking || watcher === 'waking' ? 'waking'
    : watcher === 'asleep' ? 'asleep'
    : watcher === 'running' ? 'awake'
    : watcher === 'starting' ? 'none' : 'deaf');
  // Each state's dot colour and word, the menu row's word where it differs (AGENTS.md colour priority).
  const JOIN_STATES = Object.freeze({
    awake: { colour: 'green', word: 'Running' },
    asleep: { colour: 'grey', word: 'Asleep' },
    waking: { colour: 'orange', word: 'Waking' },
    none: { colour: 'grey', word: 'No session yet' },
    down: { colour: 'red', word: 'Server not answering', row: 'Not answering' },
    deaf: { colour: 'red', word: 'Not listening' },
  });
  const TERMINAL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7 5 5-5 5"/><path d="M12 18h7"/></svg>';
  const COPY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5v14"/><path d="M15 5v14"/></svg>';
  const PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v15l12-7.5Z"/></svg>';
  // The board menu's rows, in order: Join in terminal with the session's state on its right; Repo review (the bulb), absent
  // while the board has no repo, with arch {running, at} saying whether a review runs or when the last one was; Pause or
  // Resume, with pause {paused, mine, words}: paused is the board's gate holding, mine that the owner's Pause board holds it,
  // words when it ends. A pause that isn't the board's own is shown but can't be tapped, as Resume wouldn't end it.
  // Settings is last: the link the shell opens as Board Settings (aria-disabled until `settings`, the header's controls, is on).
  const boardMenu = (state, { settings = true, arch = null, pause = null } = {}) => {
    const { iconText, GEAR, BULB } = globalThis.BoardUI;
    const s = JOIN_STATES[state];
    const row = (attrs, icon, name, right, tag = 'button') => `<${tag} role="menuitem" class="board-menu-item" ${attrs}>${icon}<span>${name}</span>${right}</${tag}>`;
    const rows = [row('type="button" data-join-open', TERMINAL, 'Join in terminal', iconText('dot', s.colour, s.row || s.word))];
    if (arch) {
      const day = new Date(arch.at).toLocaleDateString([], { month: 'short', day: 'numeric' });
      rows.push(row('type="button" data-arch-sheet aria-haspopup="dialog"', BULB, 'Repo review', arch.running ? iconText('dot', 'orange', 'Running') : iconText('dot', 'grey', arch.at ? `Last review ${day}` : 'No review yet')));
    }
    if (pause) {
      rows.push(!pause.paused ? row('type="button" data-pause-open aria-haspopup="dialog"', PAUSE, 'Pause', iconText('dot', 'green', 'Running'))
        : pause.mine ? row('type="button" data-pause-resume', PLAY, 'Resume', iconText('dot', 'grey', `Paused ${pause.words}`))
        : row('type="button" aria-disabled="true" disabled', PAUSE, 'Pause', iconText('dot', 'grey', `Paused ${pause.words}`)));
    }
    rows.push(row(`href="settings.html" id="settingsLink" aria-haspopup="dialog"${settings ? '' : ' aria-disabled="true" tabindex="-1"'}`, GEAR, 'Settings', '', 'a'));
    return rows.join('');
  };
  // The sheet's inside: the state, the command with Copy (greyed with Wake while asleep, Wake's spinner with no text
  // while waking, no Wake while the server is down), how to leave it running, and what /exit does.
  const joinSheet = (join, state) => {
    const s = JOIN_STATES[state];
    const head = `<p class="join-state">${globalThis.BoardUI.iconText('dot', s.colour, s.word)}</p>`;
    if (state === 'none') return `${head}<p>This board has no orchestrator session yet, so there is nothing to join.</p><p class="muted small">The hub starts one when the board's first event arrives; the command appears here then.</p>`;
    const copy = `<button type="button" class="join-copy" data-join-copy aria-label="Copy the command">${COPY}<span>Copy</span></button>`;
    const button = state === 'asleep' ? '<button type="button" class="join-wake" data-join-wake>Wake</button>'
      : state === 'waking' ? '<button type="button" class="join-wake" data-join-wake aria-busy="true" aria-label="Waking" disabled></button>' : copy;
    const greyed = state === 'asleep' || state === 'waking';
    const note = state === 'asleep' ? 'Asleep: it wakes when you open the board or an event lands. Wake it now to join.'
      : state === 'waking' ? 'The hub is resuming the session. The command works once it runs.'
      : state === 'down' ? 'From the saved copy, while the server doesn’t answer.'
      : state === 'deaf' ? 'Its session isn’t listening for the board’s events. The command opens it while it runs.' : '';
    const leave = join.tmux ? '<kbd>ctrl-b</kbd> <kbd>d</kbd> leaves it running.'
      : '<kbd>←</kbd> (agent view) or <kbd>Ctrl+Z</kbd> (shell) leaves it running.';
    return `${head}<div class="join-cmd${greyed ? ' asleep' : ''}"><code>${esc(join.command)}</code>${button}</div>`
      + `${note ? `<p class="muted small">${note}</p>` : ''}<p class="small">${leave}</p><p class="muted small">/exit ends the session; the hub wakes it on the next event.</p>`;
  };

  Object.assign(globalThis.BoardUI, { statusLine, freshSig, nextFresh, githubLine, remoteLine, brokenLinks, linksList, setupCard, pendingCheck, githubRefresh, refreshIcon, headerControls, joinState, JOIN_STATES, boardMenu, joinSheet });
})();
