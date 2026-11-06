// Work card renderers: the lines and chips of a card in a lane, on the board page. Needs ui.js, ui-enums.js and ui-phase-bars.js.
(function () {
  const { esc, ago, lasted, clock, cardTime, etaLine, workingLine, badge, bumpButton, cardBumpButton, editButton, withdrawButton, BUTTON, ACTION_KIND, BUILDER_KIND, PR_STATE, LINK_ARROW, phaseBars: bars } = globalThis.BoardUI;
  const EXTERNAL = { target: '_blank', rel: 'noopener' };
  // The PR badge is the one place a PR's state shows: its mark and tone, marked like the reviewer and CI chips, and its
  // title (docs/adr/2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md). A card with several PRs shows a
  // badge for each, in its order (docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md).
  const PR_LOOK = {
    [PR_STATE.open]: { tone: 'quiet', mark: ' ✓', label: 'Open' },
    [PR_STATE.draft]: { tone: 'notice', mark: ' ●', label: 'Draft' },
    [PR_STATE.merged]: { tone: 'merged', mark: ' ✓', label: 'Merged' },
    [PR_STATE.closed]: { tone: 'danger', mark: ' ✗', label: 'Closed' },
  };
  // An open PR reads green only while it waits on a reviewer alone: CI passed and no reviewer asked for changes.
  const waitsOnReviewer = (pr) => pr.checks?.state === 'pass' && pr.reviewDecision !== 'CHANGES_REQUESTED';
  const prChips = (it) => (it.prs || []).map(prChip).join('');
  // A PR's short name, its repo's name and number: kickflip#6.
  const prName = (pr) => `${(pr.url.match(/github\.com\/[^/]+\/([^/]+)\//) || [])[1] || ''}#${pr.number}`;
  function prChip(pr) {
    const base = PR_LOOK[pr.status] || { tone: 'quiet', mark: '', label: '' };
    const look = pr.status === PR_STATE.open && waitsOnReviewer(pr) ? { ...base, tone: 'ready', label: 'Ready for review' } : base;
    const CI = { pass: { tone: 'ready', mark: '✓' }, fail: { tone: 'danger', mark: '✗' }, pending: { tone: 'notice', mark: '●' } }[pr.checks?.state] || { tone: 'quiet', mark: '?' };
    const ci = pr.checks && pr.state === 'OPEN' ? badge(CI.tone, `CI ${CI.mark}`, { title: `CI ${pr.checks.state}` }) : '';
    const codex = pr.state === 'OPEN' && pr.codexOpen ? badge('notice', `codex ${esc(pr.codexOpen)}`, { title: `${pr.codexOpen} Codex finding${pr.codexOpen === 1 ? '' : 's'} not answered yet` }) : '';
    const name = prName(pr);
    const label = look.label ? { title: look.label, attrs: { ...EXTERNAL, 'aria-label': `${name}: ${look.label}` } } : { attrs: EXTERNAL };
    return `${badge(look.tone, `${esc(name)}${look.mark}`, { href: pr.url, ...label })}${ci}${codex}`;
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
      const age = reviewAge(rv).trim();
      return badge(s.tone, `${esc(rv?.github || r)}${age ? ` (${age})` : ''} ${s.mark}`, { title: `${r}${rv?.github ? ` (${rv.github})` : ''}: ${s.label}` });
    }).join('');
  }
  const pendingQuestions = (it) => (it.questions && it.questions.state !== 'resolved' ? it.questions.open + it.questions.answered + it.questions.replied : 0);
  // docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md
  // Action needed, last of the time line's orange words, linking to what the owner acts on
  // (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md).
  function actionWords(it) {
    if (!it.action) return '';
    const external = it.action.kind === ACTION_KIND.ready ? Object.entries(EXTERNAL).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
    return `<a class="card-action" href="${esc(it.action.url)}" title="${esc(it.action.label)}" aria-label="${esc(`Action needed: ${it.action.label}`)}"${external}>Action needed</a>`;
  }
  // Each unfinished dep, linking to its card: "blocked by #53, #54", or "waits on #53" on a bumped card not held, which
  // the pull takes once nothing blocks it (docs/adr/2026-11-05-0802-todo-has-no-queue.md).
  function blockedWords(it) {
    const deps = it.blockedBy || [];
    const lead = it.bumpedAt && !it.held ? 'waits on ' : 'blocked by ';
    return deps.map((d, i) => `<a class="card-blocked" href="#item=${encodeURIComponent(d.key)}">${i ? '' : lead}${esc(d.ref)}</a>`).join('<span class="sep">, </span>');
  }
  const tryWords = (kind) => kind === 'app' ? {
    go: 'Serve', going: 'serving…', done: 'Install', failed: 'serve failed',
    current: 'Nothing new to serve: Install already has this card’s latest push.',
    busy: 'Serving now. The badge turns back into Install when the new build is ready.',
    autoSub: 'The hub serves each card after each push, and main after each merge.',
    saved: (on) => on ? 'Saved. Each push serves its card.' : 'Saved. Cards wait for your Serve.',
  } : {
    go: 'Serve', going: 'serving…', done: 'Visit', failed: 'serve failed',
    current: 'Nothing new to serve: Visit already shows this card’s latest push.',
    busy: 'Serving now. The badge turns back into Visit when the new server is up.',
    autoSub: 'The hub serves each card after each push, and main after each merge.',
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
  // A card's Serve / Build, only while the board's Auto-build is off and its branch has changes
  // (docs/adr/2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md).
  function tryButton(it) {
    const t = tryOf(it);
    if (it.kind !== 'work' || !t?.script || t.autoBuild || !t.changes) return '';
    const words = tryWords(t.kind);
    const reason = t.state === 'running' ? words.busy : t.state === 'ready' && !t.stale ? words.current : '';
    const attrs = BoardUI.pending.has(`${it.key}:try`) ? BoardUI.BUSY : reason ? ` aria-disabled="true" title="${esc(reason)}" data-tip="${esc(reason)}"` : '';
    return `<button type="button" data-try="${esc(it.key)}"${attrs}>${t.state === 'failed' && !reason ? 'Retry' : words.go}</button>`;
  }
  const BRANCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/></svg>';
  // Main's refresh icon on a local board (docs/adr/2026-11-03-1914-a-local-boards-main-pulls-from-origin-on-its-own.md),
  // the header's refresh icon as a ghost button right of the timestamp: it spins while a pull runs or a tap waits on the
  // server, and turns red when the last pull failed, with the reason as a tooltip on hover or a popover a tap opens
  // (`open`). Visit is left alone: it changes only once Main rebuilds.
  function mainPull(pull, { open = false } = {}) {
    if (!pull) return '';
    const busy = pull.running || BoardUI.pending.has('main:pull');
    const failed = !busy && pull.error;
    const label = busy ? 'Pulling main' : failed ? pull.error : 'Pull main now';
    const why = failed ? `<span class="main-pull-why${open ? ' open' : ''}" role="tooltip">${esc(pull.error)}</span>` : '';
    return `<span class="main-pull"><button class="ghost gh-refresh${busy ? ' spinning' : ''}${failed ? ' failed' : ''}" type="button" data-main-pull aria-label="${esc(label)}"${busy ? ' aria-disabled="true"' : ''}>${BoardUI.refreshIcon(14)}</button>${why}</span>`;
  }
  function mainBar(main, pulling) {
    if (!main) return '';
    const words = tryWords(main.kind);
    const url = tryURL(main);
    const chip = main.state === 'running' ? badge('notice', spinner + esc(words.going), { attrs: { role: 'status' } })
      : main.state === 'failed' ? badge('danger', esc(words.failed), { button: true, attrs: { type: 'button', 'data-main-log': '', 'aria-haspopup': 'dialog' }, title: 'Read main’s build log and retry this tip.' })
      : main.state === 'ready' && url ? badge('ready', `${words.done} ${LINK_ARROW}`, { href: url, attrs: main.kind === 'web' ? EXTERNAL : {} }) : '';
    return `<div class="tb-main" role="region" aria-label="Main’s version">${BRANCH}<div class="tb-main-text">${esc(main.slug)} · <strong>${esc(main.branch)}</strong>@<code>${esc(main.sha)}</code> · ${esc(ago(main.at))}${mainPull(main.pull, pulling)}</div><div class="meta">${chip}</div></div>`;
  }
  // The open card's Merge, while the board's auto-merge is off: it confirms, then sends card-merge, waiting while the
  // server records it (app-cards.js), and waits (ui.js BUSY) while the session merges it, or the board server lands a
  // card with no PR, and from the tap until a board shows the card left In Review or its merge refused (ui.js pending) (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md,
  // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
  function mergeButton(it) {
    if (it?.action?.kind !== ACTION_KIND.merge && !it?.merging) return '';
    const busy = it.merging || BoardUI.pending.has(`${it.key}:merge`);
    // A merging card has no Action needed left, so resolvedBy is null by then: merging keeps the colour resolvedBy gave it.
    return `<button class="${it.merging || it.resolvedBy === BUTTON.merge ? 'resolves' : 'primary'}" data-confirm="merge" data-key="${esc(it.key)}"${busy ? BoardUI.BUSY : ''}>Merge</button>`;
  }
  // A builder reads "starting" until its first status line, from the Implement tap or the session's dispatch on, and
  // ends with how long ago that line was set. One whose process is gone leads with stopped; one whose live process
  // went quiet keeps its words and only turns grey (domain.mjs builderOf; docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md).
  const builderLine = (b) => [b.alive === false && 'stopped', b.progress || (b.alive === false ? null : 'starting'), b.at && lasted(b.at)].filter(Boolean).join(' · ');
  // Five bars at the end of an In Progress card's time row: reached phases filled, a running one marked. The phases are
  // store.mjs PHASES (docs/adr/2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md,
  // docs/adr/2026-11-03-1519-a-building-cards-phase-bars-end-its-time-row.md).
  const BUILD_PHASES = ['reading', 'building', 'testing', 'checking', 'landing'];
  const stepWords = (phase) => `step ${BUILD_PHASES.indexOf(phase) + 1} of ${BUILD_PHASES.length}`;
  const ALL_DONE = `all ${BUILD_PHASES.length} steps done`;
  // What a card's bars show, or null off In Progress and on a card only a planner works on: how many phases it reached,
  // whether the last of them is running, whether it dims because the card waits on something other than a builder (its
  // questions, a blocker or queue, a reopening) or its build is stale, and its label. An install is no build: its card keeps the phase its
  // build reached, undimmed
  // (docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md).
  // A Todo card a grill or prototype runs on draws the planner's dashes instead, in blue, the grill's first and the
  // prototype's second running (docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md).
  function phaseStrip(it) {
    if (it.lane === 'todo' && it.builder?.planner) {
      const prototype = it.builder.kind === 'prototype';
      return { reached: prototype ? 2 : 1, running: true, dim: false, plan: true, label: prototype ? 'Prototyping' : 'Grilling' };
    }
    if (it.lane !== 'progress' || it.builder?.planner) return null;
    const all = BUILD_PHASES.length;
    // Orchestrator review is the checking phase, before landing (docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
    if (it.waitsOn === 'checking') return { reached: BUILD_PHASES.indexOf('checking') + 1, running: true, dim: false, label: `Orchestrator review, ${stepWords('checking')}` };
    const asking = it.action?.kind === ACTION_KIND.questions || it.action?.kind === ACTION_KIND.pick;
    const answers = asking ? ', waiting on your answers' : '';
    const name = (phase) => `${phase[0].toUpperCase()}${phase.slice(1)}`;
    if (it.builder && it.builder.kind !== BUILDER_KIND.install) {
      const reached = BUILD_PHASES.indexOf(it.builder.phase) + 1;
      return { reached, running: reached > 0, dim: asking || Boolean(it.builder.stalled || it.builder.quiet), label: `${reached ? `${name(it.builder.phase)}, ${stepWords(it.builder.phase)}` : 'Starting, no step yet'}${answers}` };
    }
    const dim = !it.builder || asking;
    if (it.reopened) return { reached: all, running: false, dim, label: `Reopened, ${ALL_DONE}${answers}` };
    const reached = BUILD_PHASES.indexOf(it.reachedPhase) + 1;
    const label = reached ? `Stopped at ${it.reachedPhase}, ${stepWords(it.reachedPhase)}` : 'No step yet';
    return { reached, running: false, dim, label: `${label}${answers}` };
  }
  // What the bars do when a card's reached count goes from prev to next across redraws, null or undefined meaning no
  // strip (docs/adr/2026-11-03-1850-the-phase-bars-animate-as-a-build-starts-advances-and-ends.md).
  function phaseMotion(prev, next) {
    const had = typeof prev === 'number';
    const has = typeof next === 'number';
    if (had !== has) return has ? 'enter' : 'leave';
    return has && next > prev ? 'fill' : null;
  }
  const phaseBars = (strip) => bars(strip, BUILD_PHASES);
  // docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
  // Every status line on an In Progress card is the phase-bar orange, and every build or plan line on a Todo card the
  // owner's blue (style.css).
  const tone = (it) => (it.lane === 'progress' ? ' in-progress' : it.lane === 'todo' ? ' in-todo' : '');
  const DOT = '<span class="working-dot" aria-hidden="true"></span>';
  // A card idle on the orchestrator (domain.mjs orchestratorWaitOf) reads waiting for orchestrator, then orchestrator
  // review with its dot once the session picks it up, each with how long ago.
  function orchestratorStatus(it) {
    const { since, picked } = it.orchestrator;
    return `<div class="line3 sub agent${tone(it)}">${picked ? `${DOT}orchestrator review · ${esc(lasted(picked))}` : `waiting for orchestrator · ${esc(lasted(since))}`}</div>`;
  }
  // A stale or stopped build's status line is the needs-you red, and a tap on it nudges Claude to check the implementer.
  // A quiet one is grey, with no dot.
  function builderStatus(it) {
    const { quiet } = it.builder;
    const classes = `line3 sub agent${it.builder.planner ? ' planner' : ''}${tone(it)}${quiet ? ' quiet' : ''}`;
    const words = `${quiet ? '' : DOT}${esc(builderLine(it.builder))}`;
    if (!it.builder.stalled || it.lane === 'done') return `<div class="${classes}">${words}</div>`;
    const nudging = BoardUI.pending.has(`${it.key}:nudge`) ? ' nudging' : '';
    return `<button type="button" class="${classes} stalled${nudging}" data-confirm="nudge" data-key="${esc(it.key)}" title="No recent progress. Nudge Claude to check this implementer">${words}</button>`;
  }
  // The open card's Status row: what runs on the card, else where its lane leaves it, never the wave file's raw status
  // (docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md).
  function statusWord(it) {
    const b = it.builder;
    if (b?.planner) return b.kind === 'prototype' ? 'prototyping' : 'grilling';
    if (b && b.kind !== BUILDER_KIND.install) return b.alive === false ? 'stopped' : b.phase === 'landing' ? 'landing' : 'implementing';
    if (it.waitsOn === 'checking') return 'Orchestrator review';
    if (it.lane === 'done') return 'done';
    if (it.grilling || it.prototyping) return 'preheating';
    if (it.lane === 'todo') return it.ready ? 'ready' : 'to do';
    if (it.lane === 'progress') return it.reachedPhase ? `stopped at ${it.reachedPhase}` : 'in progress';
    return 'in review';
  }
  const unreadCount = (othersAt, seenAt) => (seenAt ? (othersAt || []).filter((t) => String(t) > seenAt).length : 0);
  // When a hold ends, as a card reads it: the time today, the weekday within six days, else the date
  // (docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md).
  function heldUntilWords(iso, now = new Date()) {
    const d = new Date(iso);
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(d) - midnight(now)) / 86400000);
    if (days === 0) return clock(d);
    if (days > 0 && days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${clock(d)}`;
    return `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })}, ${clock(d)}`;
  }
  function holdWords(it) {
    if (!it.held) return '';
    const d = it.heldUntil && new Date(it.heldUntil);
    const title = !d ? 'Held until you unhold it.'
      : `Held until ${d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' })}, ${clock(d)}. ${it.lane === 'todo' ? 'It starts on its own then, once nothing else blocks it.' : 'Claude picks it up again then.'}`;
    return `<span class="card-hold" title="${esc(title)}">${esc(d ? `held until ${heldUntilWords(it.heldUntil)}` : 'held')}</span>`;
  }
  // A card's last line: the time its lane sorts by (domain.mjs sortAt), then its hold, what blocks it, then Action needed
  // or ready, then an In Progress card's phase bars, then its unread messages, new questions counting as one, which app-cards.js
  // takes away when the card opens (docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md,
  // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md, docs/adr/2026-11-03-1519-a-building-cards-phase-bars-end-its-time-row.md).
  const SEP = '<span class="sep"> · </span>';
  const newWords = (n, word) => n && `${n} new ${word}${n === 1 ? '' : 's'}`;
  function timeLine(it, unread, bars) {
    const iso = it.sortAt;
    const parts = [iso && `<time datetime="${esc(iso)}">${esc(cardTime(iso))}</time>`, holdWords(it), blockedWords(it), actionWords(it), it.ready && '<span class="card-ready">ready</span>'].filter(Boolean);
    const news = newWords(unread, 'message');
    const count = news ? `<span class="card-unread">${parts.length || bars ? SEP : ''}${news}</span>` : '';
    const tail = bars ? `${parts.length ? SEP : ''}${bars}` : '';
    if (!parts.length && !count && !tail) return '';
    return `<div class="line6 sub card-time">${parts.join(SEP)}${tail}${count}</div>`;
  }
  // The Hold sheet's picker (app-cards.js): /api/board's holdChoices, the chips hub/duration.mjs shares with Snooze and
  // Keep awake, then Custom. Its .hub-view root takes hub.css's duration picker rules, which view-hub-settings.js
  // durationPicker's markup also uses. Each chip's length (ms, null for Forever) is worded as when it would end if picked
  // at `now`, here rather than on the server, so the board's version doesn't change with the clock
  // (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md).
  const holdUntil = (c, now) => (c.ms === null ? 'until you unhold it' : `until ${heldUntilWords(new Date(now.getTime() + c.ms), now)}`);
  function holdPicker(key, choices, now = new Date()) {
    const chips = choices.map((c) => `<button type="button" class="btn quiet" data-hold-for="${esc(key)}" value="${esc(c.value)}" aria-label="${esc(`${c.label}, ${holdUntil(c, now)}`)}">${esc(c.label)}</button>`).join('');
    return `<div class="hub-view"><div class="dur-chips" role="group" aria-labelledby="holdTitle"><div class="dur-choices">${chips}</div>`
      + `<div class="dur-custom"><span class="btn quiet" aria-hidden="true">Custom</span><input type="datetime-local" data-hold-at="${esc(key)}" required aria-label="Custom hold until a date and time"></div></div></div>`;
  }
  // A New card's bump, edit and delete, and its line from its ask state (domain.mjs askItem;
  // docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md). top is whether it is the latest bump.
  const askActions = (it, top) => `<div class="ask-actions">${bumpButton(it, top)}${it.ask.canEdit ? editButton(it.id) : ''}${withdrawButton(it.id)}</div>`;
  // A card waiting on its owner step has the owner's Done where the bump sits: a check icon that confirms, then sends
  // card-done (app-cards.js; docs/adr/2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md).
  const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const ownerDoneButton = (it) => `<button type="button" class="ghost icon owner-done" data-confirm="finish" data-key="${esc(it.key)}" aria-label="Done" title="${esc(`Done: ${it.ownerStep}`)}">${CHECK}</button>`;
  const cardActions = (it, top) => (it.isNew ? askActions(it, top) : it.ownerStep ? `<div class="ask-actions">${ownerDoneButton(it)}</div>`
    : it.bumpable ? `<div class="ask-actions">${cardBumpButton(it.key, Boolean(it.bumpedAt))}</div>` : '');
  const askLine = (ask) => [ask.from && `Moved from ${esc(ask.from)}`, ask.edited && 'Edited', ask.state === 'working' && workingLine].filter(Boolean).join(' · ');
  // In a wave band (app-lanes.js), step is the number of the card's phase in its wave, shown inside its id chip, and actions replace
  // its bump with the band's ⋯ menu.
  function workLines(it, { unread = 0, top = false, step = 0, actions = null } = {}) {
    const ticket = it.ticket ? ticketChip(it) : it.ticketSource === 'linear' ? linearChips(it) : it.internal ? badge('quiet', esc(it.ref), { title: 'Work on this site, not a product PR' }) : linearChips(it);
    // A work card always shows its ticket; New is only on an ask (askChip).
    const chip = step ? ticket.replace(/^<[^>]*>/, (open) => `${open}<span class="wn">${step}</span>`) : ticket;
    const ids = it.kind === 'ask' ? askChip(it) : chip;
    const chips = `${prChips(it)}${reviewChips(it)}${it.risky ? badge('notice', 'risky') : ''}${installChip(it)}`;
    const status = it.isNew && !it.action ? (askLine(it.ask) && `<div class="line3 sub">${askLine(it.ask)}</div>`)
      : it.orchestrator && !it.builder ? `${it.rebaseFailed ? `<div class="line3 sub">${esc(it.rebaseFailed)}</div>` : ''}${orchestratorStatus(it)}`
      : it.waitsOn === 'checking' ? `<div class="line3 sub agent${tone(it)}">${DOT}Orchestrator review</div>`
      : it.builder ? builderStatus(it)
      : it.grilling || it.prototyping ? '<div class="line3 sub asked">preheating</div>'
      : it.refusal ? `<div class="line3 sub refused">${esc(it.refusal)}</div>`
      : it.working ? `<div class="line3 sub agent">${workingLine}</div>`
      : it.next ? `<div class="line3 sub next${it.lane === 'todo' || it.lane === 'done' || it.held ? ' idle' : ''}">Next: ${esc(it.next)}</div>` : '';
    const eta = it.eta && it.builder ? `<div class="line3 sub eta">${esc(etaLine(it.eta))}</div>` : '';
    // The owner step's code check, which closes the card when it passes (docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md).
    const check = !it.ownerCheck ? '' : it.ownerCheck.broken ? `<div class="line3 sub refused">${esc(`Check can't run: ${it.ownerCheck.broken}`)}</div>`
      : `<div class="line3 sub check">${esc(`Checks: ${it.ownerCheck.words}`)}</div>`;
    return `${actions ?? cardActions(it, top)}<div class="line1 title">${ids ? `${ids} ` : ''}${esc(it.title)}</div>
      ${status}${check}${eta}
      ${chips ? `<div class="line2 meta">${chips}</div>` : ''}
      ${timeLine(it, unread, phaseBars(phaseStrip(it)))}`;
  }
  const WAVE_ICON = '<svg class="wave-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-3 5-1.5"/><path d="M2 16c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-3 5-1.5"/></svg>';
  const askChip = (it) => (it.isNew ? badge('notice', 'New') : '');
  function planButton(items) {
    const keys = items.filter((i) => i.kind === 'work' && !i.held && !i.blockedBy?.length).map((i) => i.key);
    return keys.length > 1 ? `<button type="button" class="thread-more" data-plan="${esc(keys.join(' '))}"${BoardUI.pending.has('todo:plan') ? BoardUI.BUSY : ''}>Plan waves</button>` : '';
  }

  // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
  // The Auto Review lane, its needs you in the sidebar's needs-you red: one card per incoming PR (board/auto-review.mjs reviewsOf), needs you, then reviewing, then
  // posted. A tap opens the review text and the PR's links, and a review held for the owner offers Post it and Skip,
  // whose tap waits while the server records it (app-lanes.js). Older posted reviews are one line each under Posted earlier.
  const REVIEW_WORDS = { needs: 'needs you', reviewing: 'reviewing', posted: 'posted' };
  const REVIEW_DOTS = { needs: 'rv-needs', reviewing: 'progress', posted: 'done' };
  function reviewDetail(c) {
    const text = c.text ? `<div class="rv-review">${c.state === 'needs' ? '<p class="muted small">Draft, not posted.</p>' : ''}${BoardUI.markdown(c.text)}</div>`
      : '<p class="muted small">Nothing posted yet. Right before posting, Claude reads the PR’s reviews again and adds only new points.</p>';
    const links = `<div class="rv-links"><a href="${esc(c.url)}" target="_blank" rel="noopener">PR #${c.number} on GitHub ${LINK_ARROW}</a>${c.reviewUrl ? `<a href="${esc(c.reviewUrl)}" target="_blank" rel="noopener">The review on GitHub ${LINK_ARROW}</a>` : ''}</div>`;
    const acts = c.state === 'needs' ? `<div class="rv-acts"><button type="button" data-review-answer="post" data-review="${c.number}">Post it</button><button type="button" class="ghost" data-review-answer="skip" data-review="${c.number}">Skip</button></div>` : '';
    return `<div class="rv-detail">${text}${links}${acts}</div>`;
  }
  const reviewChipsOf = (c) => [badge('quiet', `from ${esc(c.author)}`), ...c.touches.map((t) => badge(c.state === 'needs' ? 'danger' : 'quiet', `touches ${esc(t.ref)}`)), c.asked ? badge('normal', 'asked you') : ''].join(' ');
  const reviewWhen = (c) => `${c.state === 'reviewing' ? 'started ' : ''}${ago(c.at)}`;
  function reviewCard(c, open) {
    return `<details class="rv-card" data-review="${c.number}"${open ? ' open' : ''}><summary><span class="status ${REVIEW_DOTS[c.state]}"></span><div class="title-wrap">
      <div class="line1 title">${badge('normal', `PR #${c.number}`)} ${esc(c.title)}</div>
      <div class="line3 sub${c.state === 'reviewing' ? ' agent' : ''}">${c.state === 'reviewing' ? '<span class="working-dot" aria-hidden="true"></span>' : ''}<span class="rv-word s-${c.state}">${REVIEW_WORDS[c.state]}</span> · ${esc(reviewWhen(c))}</div>
      <div class="line2 meta">${reviewChipsOf(c)}</div></div></summary>${reviewDetail(c)}</details>`;
  }
  const reviewLine = (c, open) => `<details class="rv-line" data-review="${c.number}"${open ? ' open' : ''}><summary><div class="title">${badge('normal', `PR #${c.number}`)} ${esc(c.title)}</div>
    <div class="sub">${esc([c.author, c.state === 'posted' ? `posted ${ago(c.at)}` : 'not posted', c.open ? '' : 'closed'].filter(Boolean).join(' · '))}</div></summary>${reviewDetail(c)}</details>`;
  // reviews: the built board's reviews; open: {lane, earlier, cards: Set of open PR numbers}.
  function reviewLane(reviews, { open = {} } = {}) {
    if (!reviews?.shown) return '';
    const { cards, earlier } = reviews;
    const needs = cards.filter((c) => c.state === 'needs').length;
    const shown = (n) => open.cards?.has(n);
    const fold = earlier.length ? `<details class="fold" data-fold="reviews-earlier"${open.earlier ? ' open' : ''}><summary><span class="lane-name">Posted earlier</span><span class="count">${earlier.length}</span></summary>
      <div class="fold-list">${earlier.map((c) => reviewLine(c, shown(c.number))).join('')}</div></details>` : '';
    const waiting = reviews.waiting ? `${reviews.waiting} incoming PR${reviews.waiting === 1 ? '' : 's'} wait${reviews.waiting === 1 ? 's' : ''} until the board is idle.`
      : `No incoming PR touches this board’s work yet.${reviews.at ? ` Checked ${esc(reviews.repo)} ${ago(reviews.at)}.` : ''}`;
    const list = cards.length ? cards.map((c) => reviewCard(c, shown(c.number))).join('') : `<div class="empty">${waiting}</div>`;
    return `<details class="lane" data-lane="reviews"${open.lane === false ? '' : ' open'}><summary><span class="lane-name">Auto Review</span><span class="count">${cards.length}</span>${needs ? `<span class="lane-github"><span class="rv-late">${needs} needs you</span></span>` : ''}</summary>
      <div class="list">${list}${fold}</div></details>`;
  }

  Object.assign(globalThis.BoardUI, { prChips, prName, linearChips, ticketChip, REVIEW, reviewAge, reviewChips, pendingQuestions, actionWords, blockedWords, tryWords, tryButton, mainBar, installChip, installButton, mergeButton, builderLine, statusWord, BUILD_PHASES, phaseStrip, phaseMotion, unreadCount, heldUntilWords, holdPicker, workLines, askChip, askActions, askLine, planButton, WAVE_ICON, reviewLane });
})();
