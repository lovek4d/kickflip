// The board header's time and the In Review header's GitHub line, with when a refresh asks for a check. Needs ui.js.
(function () {
  const { since, esc } = globalThis.BoardUI;
  // The header's short time beside refresh: `at` is when the page last got fresh data (nextFresh). It reads that age;
  // the board's other states only move its title; the logo's dot carries the state, and the span takes `late` past a
  // minute old, which style.css turns orange with the arrow (docs/adr/2026-11-12-1000-the-logo-dot-carries-the-hub-state.md). watcher is
  // /api/board's checks.watcher (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md).
  // link is 'online', 'offline' (the last board load failed) or 'reconnecting' (a refresh tap is retrying it, and the icon spins).
  const statusLine = (at, { link = 'online', watcher, pause, waking = false } = {}) => {
    const paused = pause?.state === 'paused';
    const reason = link === 'offline' ? "Offline: can't reach the host"
      : watcher === 'stopped' ? 'Claude not listening'
      : paused ? `Paused ${BoardUI.pauseUntilWords(pause.resets_at)}`
      : link === 'reconnecting' ? 'Reconnecting…'
      : watcher === 'waking' || (waking && watcher === 'asleep') ? 'Waking: the hub is resuming its session'
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
  // The In Review header's right end; pending is whether a check-github request is waiting.
  const githubLine = (checks, { pending = false, links = null } = {}) => {
    const mark = linksMark(links);
    if (pending) return `<span class="github">${mark} Checking…</span>`;
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
  const checkLanded = (checks, pendingSince) => Boolean(checks?.at) && Date.parse(checks.at) >= pendingSince;
  const refreshIcon = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
  // The GitHub line's own refresh, spinning and resting while a request is pending. It sits in the lane's summary, so
  // it is aria-disabled, not disabled: a resting tap must still reach app-header.js's handler, which keeps the lane from folding.
  const githubRefresh = (checks, pendingSince) => `<button class="ghost gh-refresh${pendingSince ? ' spinning' : ''}" type="button" data-check-github aria-label="Check GitHub" title="Check GitHub"${pendingSince ? ' aria-disabled="true"' : ''}>${refreshIcon(14)}</button>`;

  // Which header controls take taps, and whether refresh spins. The header paints them disabled with refresh spinning;
  // both turn on together once the first board load has answered or failed.
  // Offline, refresh stays on so a tap can retry the load (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md),
  // and Settings opens its read-only copy (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
  const headerControls = ({ wired = false, boardSettled = false, reloading = false } = {}) => {
    const ready = wired && boardSettled && !reloading;
    return { refresh: ready, settings: ready, spin: !boardSettled || reloading };
  };

  Object.assign(globalThis.BoardUI, { statusLine, freshSig, nextFresh, githubLine, remoteLine, brokenLinks, linksList, setupCard, checkLanded, githubRefresh, refreshIcon, headerControls });
})();
