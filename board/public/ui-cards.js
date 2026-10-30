// Work card renderers: the lines and chips of a card in a lane, on the board page. Needs ui.js.
(function () {
  const { esc, ago, time, etaLine, workingLine, badge, bumpButton, editButton, withdrawButton } = globalThis.BoardUI;
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
  const linearChips = (it) => it.linear.map((l) => badge('normal', esc(l.id), { href: l.url, title: `${l.id} in Linear`, attrs: EXTERNAL })).join('');
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
      const rv = it.review?.[r];
      const s = REVIEW[rv?.state || 'unsent'];
      return badge(s.tone, `${esc(r[0])} ${s.mark}${reviewAge(rv)}`, { title: `${r}: ${s.label}` });
    }).join('');
  }
  const pendingQuestions = (it) => (it.questions && it.questions.state !== 'resolved' ? it.questions.open + it.questions.answered + it.questions.replied : 0);
  // docs/adr/0045-the-lane-follows-who-acts-next.md
  function actionChip(it) {
    if (!it.action) return '';
    const external = it.action.kind === 'ready' ? EXTERNAL : {};
    return badge('notice', 'Action needed', { href: it.action.url, title: it.action.label, attrs: { ...external, 'aria-label': `Action needed: ${it.action.label}` } });
  }
  // docs/adr/0051-a-device-app-card-carries-an-install-link.md
  function installChip(it) {
    const inst = it.install;
    if (!inst) return '';
    const label = inst.label || 'Install';
    const built = [inst.builtAt && `built ${time(inst.builtAt)}`, inst.sha && `from ${inst.sha.slice(0, 7)}`].filter(Boolean).join(' ');
    const title = [built && built[0].toUpperCase() + built.slice(1), inst.older && 'the PR has newer commits'].filter(Boolean).join('; ');
    return badge(inst.older ? 'quiet' : 'ready', esc(inst.older ? `${label} · older build` : label), { href: inst.url, title: title || null, attrs: { 'aria-label': `${label}${inst.older ? ', an older build' : ''}` } });
  }
  // The open card's Merge, while the board's auto-merge is off: it confirms, then sends card-merge, and reads "Merging…"
  // while it is sent or waits on the session (docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md).
  function mergeButton(it, sending = false) {
    if (it?.action?.kind !== 'merge' && !it?.merging) return '';
    const merging = sending || it.merging;
    return `<button class="primary" data-confirm="merge" data-key="${esc(it.key)}"${merging ? ' disabled' : ''}>${merging ? 'Merging…' : 'Merge'}</button>`;
  }
  // The card's Build, while the session waits on the owner's go: in Action needed's place on the card and first in the
  // open card's action row. It confirms, then sends card-build, and reads "Starting…" while it is sent or waits on the session
  // (docs/adr/0053-notes-replace-the-full-plan-and-build-gives-the-go.md). The follow-up Build shares its look.
  function buildButton(it, sending = false) {
    if (it?.action?.kind !== 'build' && !it?.starting) return '';
    const starting = sending || it.starting;
    return `<button class="build" data-confirm="card-build" data-key="${esc(it.key)}"${starting ? ' disabled' : ''}>${starting ? 'Starting…' : 'Build'}</button>`;
  }
  const builderLine = (b) => [b.progress || 'Building', b.at && ago(b.at)].filter(Boolean).join(' · ');
  const unreadCount = (othersAt, seenAt) => (seenAt ? (othersAt || []).filter((t) => String(t) > seenAt).length : 0);
  // A New card's bump, edit and delete, and its line from its ask state (domain.mjs askItem;
  // docs/adr/0047-the-plus-makes-a-new-card.md). top is whether it is the latest bump.
  const askActions = (it, top) => `<div class="ask-actions">${bumpButton(it, top)}${it.ask.canEdit ? editButton(it.id) : ''}${withdrawButton(it.id)}</div>`;
  const ASK_STATE = { waiting: 'Waiting', working: `<span class="working">${workingLine}</span>` };
  const askLine = (ask) => `${esc(time(ask.askedAt))} · ${ask.edited ? 'Edited · ' : ''}${ASK_STATE[ask.state] || ''}`;
  function workLines(it, { unread = 0, top = false, sendingBuild = false } = {}) {
    const ids = it.kind === 'ask' ? askChip(it) : it.internal ? badge('quiet', esc(it.ref), { title: 'Work on this site, not a product PR' }) : linearChips(it);
    const blocked = (it.blockedBy || []).map((d) => badge('notice', `blocked by ${esc(d.ref)}`, { href: `#item=${encodeURIComponent(d.key)}` })).join('');
    const ready = !blocked && it.deps?.length && it.lane === 'todo' ? badge('ready', 'ready to start') : '';
    const chips = `${it.action?.kind === 'build' ? '' : actionChip(it)}${buildButton(it, sendingBuild)}${installChip(it)}${it.kind === 'followup' ? badge('quiet', 'follow-up') : ''}${prChips(it)}${reviewChips(it)}${it.held ? badge('quiet', 'held') : ''}${it.risky ? badge('notice', 'risky') : ''}${it.bumpedAt ? badge('normal', 'bumped') : ''}${ready}`;
    const status = it.isNew ? `<div class="line3 sub">${askLine(it.ask)}</div>`
      : it.waitsOn === 'checking' ? '<div class="line3 sub agent"><span class="working-dot" aria-hidden="true"></span>Claude checking</div>'
      : it.builder ? `<div class="line3 sub agent">${esc(builderLine(it.builder))}</div>`
      : it.working ? `<div class="line3 sub agent">${workingLine}</div>`
      : it.next ? `<div class="line3 sub next">Next: ${esc(it.next)}</div>` : '';
    const eta = it.eta && it.builder ? `<div class="line3 sub eta">${esc(etaLine(it.eta))}</div>` : '';
    return `${it.isNew ? askActions(it, top) : ''}<div class="line1 title">${ids ? `${ids} ` : ''}${esc(it.title)}</div>
      ${status}${eta}${unread ? `<div class="line4 sub unread">${unread} unread message${unread === 1 ? '' : 's'}</div>` : ''}
      ${chips ? `<div class="line2 meta">${chips}</div>` : ''}
      ${blocked ? `<div class="line5 meta blocked">${blocked}</div>` : ''}`;
  }
  const askChip = (it) => badge('normal', it.isNew ? 'New' : 'Task');
  function planButton(items) {
    const keys = items.filter((i) => i.kind === 'followup').map((i) => i.key);
    return keys.length > 1 ? `<button class="link" data-plan="${esc(keys.join(' '))}">Plan a wave from these ${keys.length} follow-ups →</button>` : '';
  }

  Object.assign(globalThis.BoardUI, { prChips, linearChips, REVIEW, reviewAge, reviewChips, pendingQuestions, actionChip, installChip, mergeButton, buildButton, builderLine, unreadCount, workLines, askChip, askActions, askLine, planButton });
})();
