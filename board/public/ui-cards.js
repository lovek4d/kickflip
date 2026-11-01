// Work card renderers: the lines and chips of a card in a lane, on the board page. Needs ui.js and ui-enums.js.
(function () {
  const { esc, ago, time, etaLine, workingLine, badge, bumpButton, cardBumpButton, editButton, withdrawButton, BUTTON, ACTION_KIND, BUILDER_KIND } = globalThis.BoardUI;
  const EXTERNAL = { target: '_blank', rel: 'noopener' };
  function prChips(it) {
    const pr = it.pr;
    if (!pr) return '';
    const st = pr.state === 'MERGED' ? badge('ready', 'merged') : pr.state === 'CLOSED' ? badge('danger', 'closed') : '';
    // An open PR's chip ends with its state, marked like the reviewer and CI chips.
    const open = pr.state === 'OPEN' ? (pr.isDraft ? { tone: 'notice', mark: ' ●', label: 'Draft' } : { tone: 'ready', mark: ' ✓', label: 'Ready for review' }) : { tone: 'normal', mark: '', label: '' };
    const CI = { pass: { tone: 'ready', mark: '✓' }, fail: { tone: 'danger', mark: '✗' }, pending: { tone: 'notice', mark: '●' } }[pr.checks?.state] || { tone: 'quiet', mark: '?' };
    const ci = pr.checks && pr.state === 'OPEN' ? badge(CI.tone, `CI ${CI.mark}`, { title: `CI ${pr.checks.state}` }) : '';
    const repo = (pr.url.match(/github\.com\/[^/]+\/([^/]+)\//) || [])[1] || '';
    const codex = pr.state === 'OPEN' && pr.codexOpen ? badge('notice', `codex ${esc(pr.codexOpen)}`, { title: `${pr.codexOpen} Codex finding${pr.codexOpen === 1 ? '' : 's'} not answered yet` }) : '';
    const name = `${repo}#${pr.number}`;
    const label = open.label ? { title: open.label, attrs: { ...EXTERNAL, 'aria-label': `${name}: ${open.label}` } } : { attrs: EXTERNAL };
    return `${badge(open.tone, `${esc(name)}${open.mark}`, { href: pr.url, ...label })}${st}${ci}${codex}`;
  }
  const linearChips = (it) => (it.linear || []).map((l) => badge('normal', esc(l.id), { href: l.url, title: `${l.id} in Linear`, attrs: EXTERNAL })).join('');
  const ticketChip = (it) => !it.ticket ? '' : !it.ticket.url ? badge('quiet', esc(it.ticket.id), { title: `${it.ticket.id} · not from this board’s ticket source` }) : badge(it.ticket.source === 'internal' ? 'quiet' : 'normal', esc(it.ticket.id), { href: it.ticket.url, title: `${it.ticket.id}${it.ticket.source === 'internal' ? ' · this board’s own ticket' : it.ticket.source === 'github' ? ' on GitHub' : ' in Linear'}`, attrs: it.ticket.source === 'internal' ? {} : EXTERNAL });
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
  // docs/adr/0051-a-device-app-card-carries-an-install-link.md
  const installing = (it) => it.lane !== 'done' && it.builder?.kind === BUILDER_KIND.install;
  const REBUILDING_ASK = { message: 'Currently rebuilding with latest changes. Install the existing older build now?', ok: 'Install older build', cancel: 'Cancel' };
  function installState(it) {
    const inst = it.install;
    if (!inst) return installing(it) ? { tone: 'notice', label: 'Building…', title: 'Building the first install', attrs: { 'aria-disabled': 'true' } } : null;
    const label = inst.label || 'Install';
    const built = [inst.builtAt && `built ${time(inst.builtAt)}`, inst.sha && `from ${inst.sha.slice(0, 7)}`].filter(Boolean).join(' ');
    if (installing(it)) {
      return { tone: 'notice', label: 'Rebuilding…', href: inst.url, title: built ? `Older build, ${built}` : 'Older build',
        attrs: { 'data-install-confirm': it.key, 'aria-label': 'Rebuilding. Tap to install the older build' } };
    }
    const title = [built && built[0].toUpperCase() + built.slice(1), inst.older && 'the PR has newer commits'].filter(Boolean).join('; ');
    return { tone: inst.older ? 'quiet' : 'ready', label: inst.older ? `${label} · older build` : label,
      href: inst.url, title: title || null, attrs: { 'aria-label': `${label}${inst.older ? ', an older build' : ''}` } };
  }
  function installChip(it) {
    const s = installState(it);
    return s ? badge(s.tone, esc(s.label), s) : '';
  }
  function installButton(it) {
    const s = installState(it);
    if (!s) return '';
    const attrs = Object.entries({ href: s.href, title: s.title, ...s.attrs }).filter(([, v]) => v != null)
      .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const tag = s.href ? 'a' : 'span';
    return `<${tag} class="install tone-${s.tone}"${attrs}>${esc(s.label)}${s.href ? ' ↗' : ''}</${tag}>`;
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
    const chips = `${stalledChip(it)}${unreadChip(unread)}${actionChip(it)}${it.kind === 'followup' ? badge('quiet', 'follow-up') : ''}${prChips(it)}${reviewChips(it)}${it.held ? badge('quiet', 'held') : ''}${it.risky ? badge('notice', 'risky') : ''}${it.bumpedAt ? badge('normal', 'bumped') : ''}${ready}${installChip(it)}`;
    const status = it.isNew && !it.action ? `<div class="line3 sub">${askLine(it.ask)}</div>`
      : it.waitsOn === 'checking' ? '<div class="line3 sub agent"><span class="working-dot" aria-hidden="true"></span>Orchestrator review</div>'
      : it.builder ? `<div class="line3 sub agent"><span class="working-dot" aria-hidden="true"></span>${esc(builderLine(it.builder))}</div>`
      : it.working ? `<div class="line3 sub agent">${workingLine}</div>`
      : it.next ? `<div class="line3 sub next">Next: ${esc(it.next)}</div>` : '';
    const eta = it.eta && it.builder ? `<div class="line3 sub eta">${esc(etaLine(it.eta))}</div>` : '';
    const age = it.todoAge ? `<div class="line3 sub">${esc(it.todoAge)}</div>` : '';
    return `${cardActions(it, top)}<div class="line1 title">${ids ? `${ids} ` : ''}${esc(it.title)}</div>
      ${status}${eta}${age}
      ${chips ? `<div class="line2 meta">${chips}</div>` : ''}
      ${blocked ? `<div class="line5 meta blocked">${blocked}</div>` : ''}`;
  }
  const askChip = (it) => badge('normal', it.isNew ? 'New' : 'Task');
  function planButton(items) {
    const keys = items.filter((i) => i.kind === 'followup').map((i) => i.key);
    return keys.length > 1 ? `<button class="link" data-plan="${esc(keys.join(' '))}">Plan a wave from these ${keys.length} follow-ups →</button>` : '';
  }

  Object.assign(globalThis.BoardUI, { prChips, linearChips, ticketChip, REVIEW, reviewAge, reviewChips, pendingQuestions, actionChip, REBUILDING_ASK, installChip, installButton, mergeButton, builderLine, unreadCount, workLines, askChip, askActions, askLine, planButton });
})();
