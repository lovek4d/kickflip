// Work card renderers: the lines and chips of a card in a lane, on the board page. Needs ui.js and ui-enums.js.
(function () {
  const { esc, ago, time, etaLine, workingLine, badge, bumpButton, cardBumpButton, editButton, withdrawButton, BUTTON, ACTION_KIND, BUILDER_KIND, LINK_ARROW } = globalThis.BoardUI;
  const EXTERNAL = { target: '_blank', rel: 'noopener' };
  function prChips(it) {
    const pr = it.pr;
    if (!pr) return '';
    const st = pr.state === 'MERGED' ? badge('ready', 'merged') : pr.state === 'CLOSED' ? badge('danger', 'closed') : '';
    // An open PR's chip ends with its state, marked like the reviewer and CI chips.
    const open = pr.state === 'OPEN' ? (pr.isDraft ? { tone: 'notice', mark: ' ●', label: 'Draft' } : { tone: 'ready', mark: ' ✓', label: 'Ready for review' }) : { tone: 'quiet', mark: '', label: '' };
    const CI = { pass: { tone: 'ready', mark: '✓' }, fail: { tone: 'danger', mark: '✗' }, pending: { tone: 'notice', mark: '●' } }[pr.checks?.state] || { tone: 'quiet', mark: '?' };
    const ci = pr.checks && pr.state === 'OPEN' ? badge(CI.tone, `CI ${CI.mark}`, { title: `CI ${pr.checks.state}` }) : '';
    const repo = (pr.url.match(/github\.com\/[^/]+\/([^/]+)\//) || [])[1] || '';
    const codex = pr.state === 'OPEN' && pr.codexOpen ? badge('notice', `codex ${esc(pr.codexOpen)}`, { title: `${pr.codexOpen} Codex finding${pr.codexOpen === 1 ? '' : 's'} not answered yet` }) : '';
    const name = `${repo}#${pr.number}`;
    const label = open.label ? { title: open.label, attrs: { ...EXTERNAL, 'aria-label': `${name}: ${open.label}` } } : { attrs: EXTERNAL };
    return `${badge(open.tone, `${esc(name)}${open.mark}`, { href: pr.url, ...label })}${st}${ci}${codex}`;
  }
  const linearChips = (it) => (it.linear || []).map((l) => badge('quiet', esc(l.id), { href: l.url, title: `${l.id} in Linear`, attrs: EXTERNAL })).join('');
  const ticketChip = (it) => !it.ticket ? '' : !it.ticket.url ? badge('quiet', esc(it.ticket.id), { title: `${it.ticket.id} · not from this board’s ticket source` }) : badge('quiet', esc(it.ticket.id), { href: it.ticket.url, title: `${it.ticket.id}${it.ticket.source === 'internal' ? ' · this board’s own ticket' : it.ticket.source === 'github' ? ' on GitHub' : ' in Linear'}`, attrs: it.ticket.source === 'internal' ? {} : EXTERNAL });
  const REVIEW = {
    approved: { tone: 'ready', mark: '✓', label: 'approved' },
    changes: { tone: 'danger', mark: '✗', label: 'asked for changes' },
    sent: { tone: 'notice', mark: '●', label: 'sent, not approved yet' },
    unsent: { tone: 'quiet', mark: '✗', label: 'not sent yet' },
  };
  const reviewAge = (rv) => {
    const days = rv?.since ? Math.floor((Date.now() - new Date(rv.since).getTime()) / 86400000) : 0;
    return days >= 1 ? ` ${days}d` : '';
  };
  function reviewChips(it) {
    if (!it.pr || it.pr.state !== 'OPEN') return '';
    return (it.reviewers || []).map((r) => {
      const rv = globalThis.BoardUI.record(it.review, r);
      const s = REVIEW[rv?.state || 'unsent'];
      return badge(s.tone, `${esc(r[0])} ${s.mark}${reviewAge(rv)}`, { title: `${r}: ${s.label}` });
    }).join('');
  }
  const pendingQuestions = (it) => (it.questions && it.questions.state !== 'resolved' ? it.questions.open + it.questions.answered + it.questions.replied : 0);
  // docs/adr/0045-the-lane-follows-who-acts-next.md
  function actionChip(it) {
    if (!it.action) return '';
    const external = it.action.kind === ACTION_KIND.ready ? EXTERNAL : {};
    return badge('notice', 'Action needed', { href: it.action.url, title: it.action.label, attrs: { ...external, 'aria-label': `Action needed: ${it.action.label}` } });
  }
  const tryWords = (kind) => kind === 'app' ? {
    go: 'Build', going: 'Building…', done: 'Install', failed: 'Build failed',
    none: 'No changes to build: this card’s branch matches main.',
    current: 'Nothing new to build: Install already has this card’s latest push.',
    busy: 'Building now. The badge turns back into Install when the new build is ready.',
    autoSub: 'On: the hub builds each card after each push. Off: a card waits for your Build. Main builds again after every merge either way.',
    saved: (on) => on ? 'Saved. Each push builds its card.' : 'Saved. Cards wait for your Build.',
  } : {
    go: 'Serve', going: 'Serving…', done: 'Visit', failed: 'Serve failed',
    none: 'No changes to serve: this card’s branch matches main.',
    current: 'Nothing new to serve: Visit already shows this card’s latest push.',
    busy: 'Serving now. The badge turns back into Visit when the new server is up.',
    autoSub: 'On: the hub serves each card after each push. Off: a card waits for your Serve. Main serves again after every merge either way.',
    saved: (on) => on ? 'Saved. Each push serves its card.' : 'Saved. Cards wait for your Serve.',
  };
  const spinner = '<span class="try-spin" aria-hidden="true"></span>';
  const tryURL = (run) => run.kind === 'web' ? run.port ? `https://${location.hostname}:${run.port}/` : null : run.url;
  function tryOf(it) {
    if (it.lane === 'done') return null;
    const t = it.try || (it.install ? { kind: 'app', state: 'ready', stale: it.install.older, sha: it.install.sha, url: it.install.url } : null);
    const run = t ? { ...t, url: tryURL(t) } : null;
    return it.builder?.kind === BUILDER_KIND.install ? { ...run, kind: run?.kind || 'app', state: 'running' } : run;
  }
  function installState(it) {
    const t = tryOf(it);
    if (!t) return null;
    const words = tryWords(t.kind);
    if (t.state === 'running') return { tone: 'notice', html: spinner + esc(words.going), attrs: { role: 'status' } };
    if (t.state === 'failed') return { tone: 'danger', html: `${esc(words.failed)} ${LINK_ARROW}`, href: `#item=${encodeURIComponent(it.key)}`,
      title: 'The build script stopped with an error. Tap for its log in the card’s thread.', attrs: { 'data-try-log': it.key } };
    if (t.state !== 'ready' || !t.url) return null;
    return { tone: t.stale ? 'quiet' : 'ready', html: `${esc(words.done)}${t.stale ? ' (stale)' : ''} ${LINK_ARROW}`, href: t.url,
      title: t.sha ? `Built from ${t.sha}${t.stale ? '; the branch has newer commits' : ''}` : null, attrs: t.kind === 'web' ? EXTERNAL : {} };
  }
  function installChip(it) {
    const s = installState(it);
    return s ? badge(s.tone, s.html, { href: s.href, title: s.title, attrs: s.attrs }) : '';
  }
  function installButton(it) {
    const s = installState(it);
    if (!s) return '';
    const attrs = Object.entries({ href: s.href, title: s.title, ...s.attrs }).filter(([, v]) => v != null)
      .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const tag = s.href ? 'a' : 'span';
    return `<${tag} class="install tone-${s.tone}"${attrs}>${s.html}</${tag}>`;
  }
  function tryButton(it) {
    const t = tryOf(it);
    if (it.kind !== 'work' || !t?.script) return '';
    const words = tryWords(t.kind);
    const reason = !t.changes ? words.none : t.state === 'running' ? words.busy : t.state === 'ready' && !t.stale ? words.current : '';
    return `<button type="button" data-try="${esc(it.key)}"${reason ? ` aria-disabled="true" title="${esc(reason)}" data-tip="${esc(reason)}"` : ''}>${t.state === 'failed' && !reason ? 'Retry' : words.go}</button>`;
  }
  const BRANCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/></svg>';
  function mainBar(main) {
    if (!main) return '';
    const words = tryWords(main.kind);
    const url = tryURL(main);
    const chip = main.state === 'running' ? badge('notice', spinner + esc(words.going), { attrs: { role: 'status' } })
      : main.state === 'failed' ? badge('danger', esc(words.failed), { title: 'The build script stopped with an error. Its log is data/try/main.log in the board’s folder.' })
      : main.state === 'ready' && url ? badge('ready', `${words.done} ${LINK_ARROW}`, { href: url, attrs: main.kind === 'web' ? EXTERNAL : {} }) : '';
    return `<div class="tb-main" role="region" aria-label="Main’s version">${BRANCH}<div class="tb-main-text">${esc(main.slug)} · <strong>${esc(main.branch)}</strong>@<code>${esc(main.sha)}</code> · ${esc(ago(main.at))}</div><div class="meta">${chip}</div></div>`;
  }
  // The open card's Merge, while the board's auto-merge is off: it confirms, then sends card-merge, and reads "Merging…"
  // while it is sent or waits on the session (docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md).
  function mergeButton(it, sending = false) {
    if (it?.action?.kind !== ACTION_KIND.merge && !it?.merging) return '';
    const merging = sending || it.merging;
    return `<button class="${it.resolvedBy === BUTTON.merge ? 'resolves' : 'primary'}" data-confirm="merge" data-key="${esc(it.key)}"${merging ? ' disabled' : ''}>${merging ? 'Merging…' : 'Merge'}</button>`;
  }
  const builderLine = (b) => [b.progress || 'Building', b.at && ago(b.at)].filter(Boolean).join(' · ');
  const stalledChip = (it) => it.lane !== 'done' && it.builder?.stalled ? badge('danger', 'Stalled', {
    button: true, title: 'No recent progress. Nudge Claude to check this builder',
    attrs: { type: 'button', 'data-confirm': 'nudge', 'data-key': it.key },
  }) : '';
  const unreadCount = (othersAt, seenAt) => (seenAt ? (othersAt || []).filter((t) => String(t) > seenAt).length : 0);
  const unreadChip = (n) => {
    if (!n) return '';
    const label = `${n} unread message${n === 1 ? '' : 's'}`;
    return `<span class="chip unread" title="${label}" aria-label="${label}">${n} new</span>`;
  };
  // A New card's bump, edit and delete, and its line from its ask state (domain.mjs askItem;
  // docs/adr/0047-the-plus-makes-a-new-card.md). top is whether it is the latest bump.
  const askActions = (it, top) => `<div class="ask-actions">${bumpButton(it, top)}${it.ask.canEdit ? editButton(it.id) : ''}${withdrawButton(it.id)}</div>`;
  const cardActions = (it, top) => (it.isNew ? askActions(it, top) : it.bumpable ? `<div class="ask-actions">${cardBumpButton(it.key, top)}</div>` : '');
  const ASK_STATE = { waiting: 'Waiting', working: `<span class="working">${workingLine}</span>` };
  const askLine = (ask) => `${ask.from ? `Moved from ${esc(ask.from)} · ` : ''}${esc(time(ask.askedAt))} · ${ask.edited ? 'Edited · ' : ''}${ASK_STATE[ask.state] || ''}`;
  function workLines(it, { unread = 0, top = false } = {}) {
    const ids = it.kind === 'ask' ? askChip(it) : it.ticket ? ticketChip(it) : it.ticketSource === 'linear' ? linearChips(it) : it.internal ? badge('quiet', esc(it.ref), { title: 'Work on this site, not a product PR' }) : linearChips(it);
    const blocked = (it.blockedBy || []).map((d) => badge('notice', `blocked by ${esc(d.ref)}`, { href: `#item=${encodeURIComponent(d.key)}` })).join('');
    const ready = !blocked && !it.action && it.deps?.length && it.lane === 'todo' ? badge('ready', 'ready to start') : '';
    const chips = `${it.todoAge ? badge('quiet', esc(it.todoAge)) : ''}${stalledChip(it)}${unreadChip(unread)}${actionChip(it)}${it.kind === 'followup' ? badge('quiet', 'follow-up') : ''}${prChips(it)}${reviewChips(it)}${it.held ? badge('quiet', 'held') : ''}${it.risky ? badge('notice', 'risky') : ''}${it.bumpedAt ? badge('quiet', 'bumped') : ''}${ready}${installChip(it)}`;
    const status = it.isNew && !it.action ? `<div class="line3 sub">${askLine(it.ask)}</div>`
      : it.waitsOn === 'checking' ? '<div class="line3 sub agent"><span class="working-dot" aria-hidden="true"></span>Orchestrator review</div>'
      : it.builder ? `<div class="line3 sub agent"><span class="working-dot" aria-hidden="true"></span>${esc(builderLine(it.builder))}</div>`
      : it.working ? `<div class="line3 sub agent">${workingLine}</div>`
      : it.next ? `<div class="line3 sub next${it.lane === 'todo' || it.lane === 'done' || it.held ? ' idle' : ''}">Next: ${esc(it.next)}</div>` : '';
    const eta = it.eta && it.builder ? `<div class="line3 sub eta">${esc(etaLine(it.eta))}</div>` : '';
    return `${cardActions(it, top)}<div class="line1 title">${ids ? `${ids} ` : ''}${esc(it.title)}</div>
      ${status}${eta}
      ${chips ? `<div class="line2 meta">${chips}</div>` : ''}
      ${blocked ? `<div class="line5 meta blocked">${blocked}</div>` : ''}`;
  }
  const askChip = (it) => badge(it.isNew ? 'notice' : 'quiet', it.isNew ? 'New' : 'Task');
  function planButton(items) {
    const keys = items.filter((i) => i.kind === 'followup').map((i) => i.key);
    return keys.length > 1 ? `<button class="link" data-plan="${esc(keys.join(' '))}">Plan a wave from these ${keys.length} follow-ups →</button>` : '';
  }

  Object.assign(globalThis.BoardUI, { prChips, linearChips, ticketChip, REVIEW, reviewAge, reviewChips, pendingQuestions, actionChip, tryWords, tryButton, mainBar, installChip, installButton, mergeButton, builderLine, unreadCount, workLines, askChip, askActions, askLine, planButton });
})();
