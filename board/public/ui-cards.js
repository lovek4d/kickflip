// Work card renderers: the lines and chips of a card in a lane, on the board page. Needs ui.js, ui-enums.js and ui-progress-bar.js.
(function () {
  const { esc, escText, ago, lasted, clock, cardTime, etaLine, workingLine, thinkingLine, withCount, PAUSED, badge, cardBumpButton, editButton, withdrawButton, dropZone, sendButton, BUTTON, ACTION_KIND, BUILDER_KIND, PR_STATE, PHASES, LINK_ARROW, progressBar } = globalThis.BoardUI;
  const EXTERNAL = { target: '_blank', rel: 'noopener' };
  // The PR badge is the one place a PR's state and CI show: its mark and tone, with the state and the CI in its title
  // (docs/adr/2026-11-14-1600-a-prs-one-badge-shows-draft-ready-by-ci-or-merged.md): draft grey ●, ready by CI orange ●,
  // red ✗ or green ✓, merged purple ✓, closed grey ✗. A card with several PRs shows a badge for each, in its order
  // (docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md).
  const READY_BY_CI = { pass: { tone: 'ready', mark: ' ✓' }, none: { tone: 'ready', mark: ' ✓' }, fail: { tone: 'danger', mark: ' ✗' }, pending: { tone: 'notice', mark: ' ●' } };
  const PR_LOOK = {
    [PR_STATE.draft]: { tone: 'quiet', mark: ' ●', label: 'Draft' },
    [PR_STATE.merged]: { tone: 'merged', mark: ' ✓', label: 'Merged' },
    [PR_STATE.closed]: { tone: 'quiet', mark: ' ✗', label: 'Closed' },
  };
  // docs/adr/2026-11-06-1547-a-cards-pr-badges-stay-once-added.md: a PR no longer open keeps its reviewer chips at their
  // last state, gray.
  const keeps = (pr) => pr?.status === PR_STATE.merged || pr?.status === PR_STATE.closed;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const ciWords = (c) => !c ? '' : { pass: 'CI passed', none: 'no CI checks', fail: `CI failing: ${plural(c.fail, 'check')}`, pending: `CI waiting: ${c.pending} of ${plural(c.total, 'check')}` }[c.state] || '';
  const prChips = (it) => (it.prs || []).map(prChip).join('');
  // A PR's short name, its repo's name and number: kickflip#6.
  const prName = (pr) => `${(pr.url.match(/github\.com\/[^/]+\/([^/]+)\//) || [])[1] || ''}#${pr.number}`;
  function prChip(pr) {
    const open = pr.status === PR_STATE.open;
    const look = open ? { ...(READY_BY_CI[pr.checks?.state] || READY_BY_CI.pending), label: 'Ready' } : PR_LOOK[pr.status] || { tone: 'quiet', mark: '', label: '' };
    const ci = ciWords(pr.checks) || (open ? 'CI not read yet' : '');
    // docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md: while GitHub's limit holds the hub's check
    // (pr.limited, its reset), the badge dims and its title says when it resets.
    const note = pr.limited ? `GitHub rate limited, resets at ${clock(new Date(pr.limited))}` : '';
    const title = [look.label, ci, note].filter(Boolean).join(' · ');
    const dim = pr.limited ? { 'data-limited': '' } : {};
    const name = prName(pr);
    const label = look.label ? { title, attrs: { ...EXTERNAL, 'aria-label': `${name}: ${title}`, ...dim } } : { title: note || undefined, attrs: { ...EXTERNAL, ...dim } };
    return badge(look.tone, `${esc(name)}${look.mark}`, { href: pr.url, ...label });
  }
  // docs/adr/2026-11-15-0715-a-merge-mode-done-card-shows-its-commit-as-a-badge.md: a Merge-mode Done card's commit, in the PR badge's place: the short sha in mono, purple, linking the commit on GitHub.
  const commitChip = (it) => !it.commit ? '' : badge('merged', `<code>${esc(it.commit.sha)}</code>`, { href: it.commit.url, title: 'Landed commit', attrs: it.commit.url ? EXTERNAL : {} });
  const linearChips = (it) => (it.linear || []).map((l) => badge('quiet', esc(l.id), { href: l.url, title: `${l.id} in Linear`, attrs: EXTERNAL })).join('');
  const ticketChip = (it) => !it.ticket ? '' : !it.ticket.url ? badge('quiet', esc(it.ticket.id), { title: `${it.ticket.id} · not from this board’s ticket source` }) : badge('quiet', esc(it.ticket.id), { href: it.ticket.url, title: `${it.ticket.id}${it.ticket.source === 'github' ? ' on GitHub' : ' in Linear'}`, attrs: EXTERNAL });
  // docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md: a card with no ticket is a task, its T-<n>
  // only in the badge's title.
  const taskChip = (it) => badge('quiet', 'Task', { title: `${it.ref} · a task, no ticket` });
  // docs/adr/2026-11-12-1400-a-chip-per-pr-reviewer-and-git-approved-waits-for-githubs-decision.md: gray ● pending,
  // orange ● commented, red ✗ changes, green ✓ approved.
  const REVIEW = {
    approved: { tone: 'ready', mark: '✓', label: 'approved' },
    changes: { tone: 'danger', mark: '✗', label: 'asked for changes' },
    commented: { tone: 'notice', mark: '●', label: 'commented' },
    sent: { tone: 'quiet', mark: '●', label: 'sent, not reviewed yet' },
    unsent: { tone: 'quiet', mark: '●', label: 'not sent yet' },
  };
  const reviewAge = (rv) => {
    const days = rv?.since ? Math.floor((Date.now() - new Date(rv.since).getTime()) / 86400000) : 0;
    return days >= 1 ? ` ${days}d` : '';
  };
  // A chip per person on the PR: the card's reviewers, then each other GitHub login that reviewed it, Codex's bot among them.
  function reviewChips(it) {
    const live = it.pr?.state === 'OPEN';
    if (!live && !keeps(it.pr)) return '';
    const mine = (it.reviewers || []).map((r) => {
      const rv = globalThis.BoardUI.record(it.review, r);
      const s = REVIEW[rv?.state || 'unsent'];
      const age = live ? reviewAge(rv).trim() : '';
      return badge(live ? s.tone : 'quiet', `${esc(rv?.github || r)}${age ? ` (${age})` : ''} ${s.mark}`, { title: `${r}${rv?.github ? ` (${rv.github})` : ''}: ${s.label}` });
    });
    const others = (it.otherReviews || []).map(({ github, state }) => {
      const s = REVIEW[state];
      return badge(live ? s.tone : 'quiet', `${esc(github)} ${s.mark}`, { title: `${github} (not a board reviewer): ${s.label}` });
    });
    return [...mine, ...others].join('');
  }
  const pendingQuestions = (it) => (it.questions && it.questions.state !== 'resolved' ? it.questions.open + it.questions.answered + it.questions.replied : 0);
  // docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md
  // Open items on a card asking questions, else Action needed: last of the time line's orange words, linking to what the owner acts on
  // (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md).
  function actionWords(it) {
    if (!it.action) return '';
    const external = it.action.kind === ACTION_KIND.ready ? Object.entries(EXTERNAL).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
    const open = it.action.kind === ACTION_KIND.pick || it.action.kind === ACTION_KIND.questions;
    const word = open ? 'Open items' : 'Action needed';
    return `<a class="card-action${open ? ' card-open-items' : ''}" href="${esc(it.action.url)}" title="${esc(it.action.label)}" aria-label="${esc(`${word}: ${it.action.label}`)}"${external}>${word}</a>`;
  }
  // Each unfinished dep, linking to its card: "blocked by #53, #54", bumped or not; then its condition, "blocked
  // until <condition>" ("and until <condition>" after deps), then ", <reason>"
  // (docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md).
  function blockedWords(it) {
    const deps = it.blockedBy || [];
    const refs = deps.map((d, i) => globalThis.BoardUI.taskLink(d.key, d.ref, d.lane, { cls: 'card-blocked', lead: i ? '' : 'blocked by ' })).join('<span class="sep">, </span>');
    const until = it.blockedUntil ? `${deps.length ? ' and until' : 'blocked until'} ${it.blockedUntil}` : '';
    const tail = until + (it.blockReason && (refs || until) ? `, ${it.blockReason}` : '');
    return refs + (tail ? `<span class="card-blocked">${esc(tail)}</span>` : '');
  }
  const tryWords = (kind) => kind === 'app' ? {
    go: 'Serve', going: 'serving…', done: 'Install', failed: 'serve failed',
    current: 'Nothing new to serve: Install already has this task’s latest push.',
    busy: 'Serving now. The badge turns back into Install when the new build is ready.',
    autoSub: 'The hub serves each task after each push, and main after each merge.',
    saved: (on) => on ? 'Saved. Each push serves its task.' : 'Saved. Tasks wait for your Serve.',
  } : {
    go: 'Serve', going: 'serving…', done: 'Visit', failed: 'serve failed',
    current: 'Nothing new to serve: Visit already shows this task’s latest push.',
    busy: 'Serving now. The badge turns back into Visit when the new server is up.',
    autoSub: 'The hub serves each task after each push, and main after each merge.',
    saved: (on) => on ? 'Saved. Each push serves its task.' : 'Saved. Tasks wait for your Serve.',
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
    if (t.state === 'failed') return { tone: 'danger', html: `${esc(words.failed)} ${LINK_ARROW}`, href: `#selectedCard=${encodeURIComponent(it.key)}`,
      title: 'The build script stopped with an error. Tap for its log in the task’s thread.', attrs: { 'data-try-log': it.key } };
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
  // (docs/adr/2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md). A website card's serve that is running
  // or up has Kill in its place, Auto serve on or off
  // (docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md).
  function tryButton(it) {
    const t = tryOf(it);
    if (it.kind === 'work' && t?.kind === 'web' && ['running', 'ready'].includes(t.state)) {
      return `<button type="button" data-try-kill="${esc(it.key)}">Kill</button>`;
    }
    if (it.kind !== 'work' || !t?.script || t.autoBuild || !t.changes) return '';
    const words = tryWords(t.kind);
    const reason = t.state === 'running' ? words.busy : t.state === 'ready' && !t.stale ? words.current : '';
    const attrs = reason ? ` aria-disabled="true" title="${esc(reason)}" data-tip="${esc(reason)}"` : '';
    return `<button type="button" data-try="${esc(it.key)}"${attrs}>${t.state === 'failed' && !reason ? 'Retry' : words.go}</button>`;
  }
  const BRANCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/></svg>';
  // Main's refresh icon on a board with an origin (docs/adr/2026-11-03-1914-a-local-boards-main-pulls-from-origin-on-its-own.md),
  // the header's refresh icon as a ghost button right of the timestamp: it spins while a pull runs or a tap waits on the
  // server, and turns red when the last pull failed, with the reason as a tooltip on hover or a popover that opens when a pull fails
  // (`open`). Visit is left alone: it changes only once Main rebuilds.
  function mainPull(pull, { open = false } = {}) {
    if (!pull) return '';
    const busy = pull.running;
    const failed = !busy && pull.error;
    const label = busy ? 'Pulling main' : failed ? pull.error : 'Pull main now';
    const why = failed ? `<span class="main-pull-why${open ? ' open' : ''}" role="tooltip">${esc(pull.error)}</span>` : '';
    return `<span class="main-pull"><button class="ghost gh-refresh${busy ? ' spinning' : ''}${failed ? ' failed' : ''}" type="button" data-main-pull aria-label="${esc(label)}"${busy ? ' aria-disabled="true"' : ''}>${BoardUI.refreshIcon(14)}</button>${why}</span>`;
  }
  // Main's bar is one row: the name, then the commit with its age and refresh icon, on the left; Updating… or Update
  // failed and Visit on the right. When the left side doesn't fit, the commit group wraps to a second line under the
  // name; the state and Visit stay on line 1. While Main re-serves, or after its new build failed, the old server still
  // serves (main.serving): the bar names its commit and keeps Visit to it, with Updating… or Update failed beside it.
  function mainBar(main, pulling) {
    if (!main) return '';
    const words = tryWords(main.kind);
    const url = tryURL(main);
    const old = main.serving;
    const status = main.state === 'running' ? badge('notice', `${spinner}Updating…`, { attrs: { role: 'status' } })
      : main.state === 'failed' ? badge('danger', 'Update failed', { button: true, attrs: { type: 'button', 'data-main-log': '', 'aria-haspopup': 'dialog' }, title: 'Read main’s build log and retry this tip.' }) : '';
    const visit = (main.state === 'ready' || old) && url ? badge('ready', `${words.done} ${LINK_ARROW}`, { href: url, attrs: main.kind === 'web' ? EXTERNAL : {} }) : '';
    const shown = old || main;
    return `<div class="tb-main" role="region" aria-label="Main’s version"><div class="tb-main-left"><div class="tb-main-name">${BRANCH}<span>${esc(main.slug)}</span></div>`
      + `<div class="tb-main-commit"><span class="tb-main-text"><strong>${esc(main.branch)}</strong>@<code>${esc(shown.sha)}</code> <span class="muted">${esc(lasted(shown.at))}</span></span>${mainPull(main.pull, pulling)}</div></div><div class="meta">${status}${visit}</div></div>`;
  }
  // The open card's Merge, while the board's auto-merge is off: it confirms, then sends card-merge, waiting while the
  // server records it (app-cards.js), and waits (ui.js BUSY) while the session merges it, or the board server lands a
  // card with no PR, and from the tap until a board shows the card left In Review or its merge refused (ui.js pending) (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md,
  // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
  // A blocked card's Merge shows disabled, its tooltip naming what blocks it
  // (docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md).
  function mergeButton(it) {
    if (it?.mergeBlocked) return `<button class="primary" disabled title="${esc(it.mergeBlocked)}">Merge</button>`;
    if (it?.action?.kind !== ACTION_KIND.merge && !it?.merging) return '';
        // A merging card has no Action needed left, so resolvedBy is null by then: merging keeps the colour resolvedBy gave it.
    return `<button class="${it.merging || it.resolvedBy === BUTTON.merge ? 'resolves' : 'primary'}" data-confirm="merge" data-key="${esc(it.key)}"${it.merging ? BoardUI.BUSY : ''}>Merge</button>`;
  }
  // A builder reads "starting" until its first status line, from the Implement tap or the session's dispatch on, and
  // ends with how long ago that line was set. One whose process is gone leads with stopped; one whose live process
  // is silent keeps its words and colour (domain.mjs builderOf; docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md).
  // One the orchestrator stopped reads the stop's words and how long ago it stopped
  // (docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md).
  const builderLine = (b) => (b.stopped ? withCount(b.stopped, b.silentSince)
    : withCount([b.alive === false && 'stopped', b.progress || (b.alive === false ? null : 'starting')].filter(Boolean).join(' · '), b.at));
  // Five bars at the end of an In Progress card's time row: reached phases filled, a running one marked. The phases are
  // store.mjs PHASES (docs/adr/2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md,
  // docs/adr/2026-11-03-1519-a-building-cards-phase-bars-end-its-time-row.md).
  const BUILD_PHASES = PHASES.progress;
  const stepWords = (phase) => `step ${BUILD_PHASES.indexOf(phase) + 1} of ${BUILD_PHASES.length}`;
  const ALL_DONE = `all ${BUILD_PHASES.length} steps done`;
  // A card's progress bar (ui-progress-bar.js), In Progress's phase, or null off In Progress and on a card only a planner
  // works on: how many phases it reached, which of them is running, whether it dims because the card waits on something
  // other than a builder (its questions, a blocker or queue, a reopening), its build is stale or paused, and its label. An install
  // is no build: its card keeps the phase its build reached, undimmed
  // (docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md, docs/adr/2026-11-11-1200-every-lane-has-phases.md).
  function phaseStrip(it) {
    if (it.lane !== 'progress' || it.builder?.planner) return null;
    const all = BUILD_PHASES.length;
    // Orchestrator review is the checking phase, before landing (docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
    const checking = BUILD_PHASES.indexOf('checking');
    if (it.waitsOn === 'checking') return { count: all, done: checking + 1, now: checking, label: `Orchestrator review, ${stepWords('checking')}` };
    const asking = it.action?.kind === ACTION_KIND.questions || it.action?.kind === ACTION_KIND.pick;
    const answers = asking ? ', waiting on your answers' : '';
    const name = (phase) => `${phase[0].toUpperCase()}${phase.slice(1)}`;
    if (it.builder && it.builder.kind !== BUILDER_KIND.install) {
      const done = BUILD_PHASES.indexOf(it.builder.phase) + 1;
      return { count: all, done, now: done ? done - 1 : undefined, dim: asking || Boolean(it.builder.pause?.paused), label: `${done ? `${name(it.builder.phase)}, ${stepWords(it.builder.phase)}` : 'Starting, no step yet'}${answers}` };
    }
    const dim = !it.builder || asking;
    if (it.reopened) return { count: all, done: all, dim, label: `Reopened, ${ALL_DONE}${answers}` };
    const done = BUILD_PHASES.indexOf(it.reachedPhase) + 1;
    const label = done ? `Stopped at ${it.reachedPhase}, ${stepWords(it.reachedPhase)}` : 'No step yet';
    return { count: all, done, dim, label: `${label}${answers}` };
  }
  // What the bars do when a card's done count goes from prev to next across redraws, null or undefined meaning no
  // strip (docs/adr/2026-11-03-1850-the-phase-bars-animate-as-a-build-starts-advances-and-ends.md).
  function phaseMotion(prev, next) {
    const had = typeof prev === 'number';
    const has = typeof next === 'number';
    if (had !== has) return has ? 'enter' : 'leave';
    return has && next > prev ? 'fill' : null;
  }
  // A run's status line takes its card's lane colour (style.css): grey in Todo, the phase-bar orange in In Progress, blue in
  // In Review (docs/adr/2026-11-06-0145-every-run-takes-its-lanes-colour.md). A Done card's line keeps the plain orange.
  const tone = (it) => (['todo', 'progress', 'review'].includes(it.lane) ? ` in-${it.lane}` : '');
  const DOT = '<span class="working-dot" aria-hidden="true"></span>';
  // A card idle on the orchestrator (domain.mjs orchestratorWaitOf) reads waiting for orchestrator, then orchestrator
  // review with its dot once the session picks it up, each with how long ago.
  // docs/adr/2026-11-15-1700-a-card-reads-thinking-from-its-events-delivery-until-the-orchestrator-writes.md: while the
  // orchestrator holds an event of the card it hasn't written on yet, the card reads thinking, from that event's handover.
  function orchestratorStatus(it) {
    if (it.working) return `<div class="line3 sub agent">${thinkingLine(it.workingSince)}</div>`;
    const { since, picked } = it.orchestrator;
    const words = picked ? `${DOT}${esc(withCount('orchestrator review', picked))}` : esc(withCount('waiting for orchestrator', since));
    return `<div class="line3 sub agent${tone(it)}${picked ? '' : ' waiting-gray'}">${words}</div>`;
  }
  // docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md
  // A verified card's land step (domain.mjs landStep) in its words: a fault or a gone worktree in red, a hold, a block or
  // an open question in grey, a lander starting or running in its lane's colour with the dot.
  function landStatus(it) {
    const { step, words } = it.land;
    if (step === 'fault' || step === 'worktree-gone') return `<div class="line3 sub refused">${escText(words)}</div>`;
    if (step === 'held' || step === 'blocked' || step === 'asking') return `<div class="line3 sub agent waiting-gray">${escText(words)}</div>`;
    return `<div class="line3 sub agent${tone(it)}">${DOT}${escText(words)}</div>`;
  }
  // docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
  // A stale build's status line and bars keep their lane colour: stale shows only as the footer word. One the
  // orchestrator stopped has no dot.
  function builderStatus(it) {
    const classes = `line3 sub agent${it.builder.planner ? ' planner' : ''}${tone(it)}`;
    if (it.builder.stopped) return `<div class="${classes}">${esc(builderLine(it.builder))}</div>`;
    return `<div class="${classes}">${DOT}${esc(builderLine(it.builder))}</div>`;
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
  // docs/adr/2026-11-11-1200-every-lane-has-phases.md
  // A Todo, In Review or Done card's phase as a word: blue for a New card, grey while a planner or machine waits
  // (discussing, grilling, prototyping), orange while it waits on the owner, green once it can go and purple once merged.
  // In Progress shows its phase only as its progress bar, and a card In Review for an owner wait other than the merge has none. The word shows
  // whether the card is held or blocked; those words follow it.
  const PHASE_LOOK = {
    new: ['new', 'info'], discussing: ['discussing', 'quiet'], grilling: ['grilling', 'quiet'], prototyping: ['prototyping', 'quiet'], staging: ['staged', 'notice'], ready: ['ready', 'success'],
    draft: ['draft', 'quiet'], reviewers: ['pending review', 'notice'], merge: ['pending merge', 'notice'], stale: ['stale', 'quiet'],
    merged: ['merged', 'merged'], closed: ['closed', 'quiet'],
  };
  function phaseWord(it) {
    if (it.kind !== 'work' || it.lane === 'progress' || !it.phase) return '';
    const [word, tone] = PHASE_LOOK[it.phase];
    return `<span class="card-phase ph-${tone}">${word}</span>`;
  }
  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
  // A paused build's word and cause, which stand in for the hold or block that caused it: "pausing · blocked by #61" in
  // orange while its builder runs on to its stopping point, then "paused · blocked by #61" in grey.
  const pauseOf = (it) => (it.lane === 'progress' ? it.builder?.pause ?? null : null);
  const pauseWords = (pause) => pause && `<span class="card-${pause.paused ? 'paused' : 'pausing'}">${pause.paused ? 'paused' : 'pausing'} · ${esc(pause.words)}</span>`;
  // A card's last two rows. The footer: the time its lane sorts by (domain.mjs sortAt), then its phase word (phaseWord),
  // then its hold and what blocks it, then a build's stale in grey, held while host recovers on a bumped
  // ready card a busy host holds, in grey (docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md),
  // a paused build's words (pauseWords), then an In Progress card's phase bars
  // (docs/adr/2026-11-03-1519-a-building-cards-phase-bars-end-its-time-row.md). The row under it, drawn only when it has
  // something: Action needed and the unread messages in bold orange, new questions counting as one (app-cards.js takes
  // the count away when the card opens), then stalled in red, rightmost
  // (docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md,
  // docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md,
  // docs/adr/2026-11-12-0600-action-needed-and-new-messages-get-their-own-row.md).
  const SEP = '<span class="sep"> · </span>';
  const newWords = (n, word) => n && `${n} new ${word}${n === 1 ? '' : 's'}`;
  function timeLine(it, unread, bars) {
    const iso = it.sortAt;
    const pause = pauseOf(it);
    const holdBlock = [pause?.cause !== 'held' && holdWords(it), pause?.cause !== 'blocked' && blockedWords(it)].filter(Boolean);
    const footer = [iso && `<time datetime="${esc(iso)}">${esc(cardTime(iso))}</time>`, phaseWord(it), ...holdBlock,
      it.hostHeld && '<span class="card-host-held">held while host recovers</span>',
      !it.stalled && it.stale && it.phase !== 'stale' && '<span class="card-stale">stale</span>', pauseWords(pause), bars].filter(Boolean);
    const news = newWords(unread, 'message');
    const alert = [actionWords(it), news && `<span class="card-unread">${news}</span>`, it.stalled && '<span class="card-stalled">stalled</span>', it.plannerQueued && PAUSED].filter(Boolean);
    return [footer.length && `<div class="line6 sub card-time">${footer.join(SEP)}</div>`,
      alert.length && `<div class="line6 sub card-alert">${alert.join(SEP)}</div>`].filter(Boolean).join('');
  }
  // The Hold sheet's picker (app-cards.js): /api/board's holdChoices, the chips hub/duration.mjs shares with Snooze and
  // Pause hub, then Custom. Its .hub-view root takes hub.css's duration picker rules, which view-hub-settings.js
  // durationPicker's markup also uses. Each chip's length (ms, null for Forever) is worded as when it would end if picked
  // at `now`, here rather than on the server, so the board's version doesn't change with the clock
  // (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md).
  const holdUntil = (c, now) => (c.ms === null ? 'until you unhold it' : `until ${heldUntilWords(new Date(now.getTime() + c.ms), now)}`);
  function holdPicker(key, choices, now = new Date()) {
    const chips = choices.map((c) => `<button type="button" class="btn quiet" data-hold-for="${esc(key)}" value="${esc(c.value)}" aria-label="${esc(`${c.label}, ${holdUntil(c, now)}`)}">${esc(c.label)}</button>`).join('');
    return `<div class="hub-view"><div class="dur-chips" role="group" aria-labelledby="holdTitle"><div class="dur-choices">${chips}</div>`
      + `<div class="dur-custom"><span class="btn quiet" aria-hidden="true">Custom</span><input type="datetime-local" data-hold-at="${esc(key)}" required aria-label="Custom hold until a date and time"></div></div></div>`;
  }
  // A card waiting on its owner step has the owner's Done where the bump sits: a check icon that confirms, then sends
  // card-done (app-cards.js; docs/adr/2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md).
  const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const ownerDoneButton = (it) => `<button type="button" class="ghost icon owner-done" data-confirm="finish" data-key="${esc(it.key)}" aria-label="Done" title="${esc(`Done: ${it.ownerStep}`)}">${CHECK}</button>`;
  const cardActions = (it) => (it.ownerStep ? `<div class="ask-actions">${ownerDoneButton(it)}</div>`
    : it.bumpable ? `<div class="ask-actions">${cardBumpButton(it.key, Boolean(it.bumpedAt))}</div>` : '');

  // docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md
  // The New strip above the lanes. Its entries: each ask the orchestrator has yet to ingest (a card still isNew, which
  // no lane draws), and each one ingested since its card was last read, into a card of its own (the card's ingested) or
  // added to another card (the board's merges). Oldest sent first. seen is each card's read mark (app-core.js).
  // docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md: also each question another
  // board asked this one until its orchestrator answers it (the board's boardAsks, domain.mjs newBoardAsks).
  const unreadSince = (seen, key, at) => String(at) > String(seen[key] || '');
  function newEntries(d, seen) {
    const asks = d.items.filter((it) => it.isNew).map((it) => ({ id: it.ask.eventId, key: it.key, sent: it.created, ask: it.ask, text: it.ask.text, note: it.ask.note, files: it.ask.files }));
    const made = d.items.filter((it) => it.ingested && unreadSince(seen, it.key, it.ingested.at))
      .map((it) => ({ id: it.fromAsk, key: it.key, sent: it.created, at: it.ingested.at, text: it.ingested.text, files: it.ingested.files, made: it, lane: it.lane }));
    const added = (d.merges || []).filter((m) => unreadSince(seen, m.key, m.at))
      .map((m) => ({ id: m.id, key: m.key, sent: m.askedAt, at: m.at, text: m.message, files: m.files, into: m, lane: d.items.find((it) => it.key === m.key)?.lane }));
    const questions = (d.boardAsks || []).map((q) => ({ id: q.id, sent: q.sent, text: q.text, question: q }));
    return [...asks, ...made, ...added, ...questions].sort((a, b) => String(a.sent).localeCompare(String(b.sent)));
  }
  // docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md: an ask reads a grey "triaging" (below), its
  // dot still, until the orchestrator picks it up (the watcher's or the PostToolUse hook's working mark), then
  // "processing...", the owner's word, while the orchestrator triages it. Another board's question reads a grey
  // "waiting…" until then.
  const PICKUP_WAIT = '<span class="pickup-wait"><span class="working-dot" aria-hidden="true"></span>waiting…</span>';
  const PROCESSING = `<span class="processing">${DOT}processing...</span>`;
  const processing = (since) => (since ? globalThis.BoardUI.counted('processing', 'processing...', since) : PROCESSING);
  // docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md: a New task waiting for
  // pick-up reads a grey "triaging", its dot still, counting up from when it was asked through the shared duration.
  const triaging = (askedAt) => globalThis.BoardUI.counted('pickup-wait', 'triaging', askedAt);
  // A handed ask's source line links the card it came from
  // (docs/adr/2026-11-14-2340-handoff-moves-a-ticket-to-another-board-and-leaves-a-pointer.md).
  const askLine = (ask) => [ask.from && `<a class="new-source" href="${esc(ask.from.link)}">From ${esc(ask.from.words)}</a>`, ask.edited && 'Edited', ask.state === 'working' ? processing(ask.since) : ask.state === 'waiting' && triaging(ask.askedAt)].filter(Boolean).join(' · ');
  // An entry waiting or processing edits and deletes its ask, its edit box in place of its text (edit, from
  // app-asks.js's state.edits); an ingested one links to its card, in blue, and dismisses with no confirm. The link and
  // Dismiss both read the card up to the ingest (app-asks.js), so following the link clears the entry too.
  // An ask's edit box, in place of its text; app-asks.js handles the form, and attach.js the files it adds to the ask,
  // under composer id edit:<ask id>.
  const editForm = (id, text) => `<form class="edit-form" data-edit-form="${esc(id)}" data-composer="edit:${esc(id)}">${dropZone(`<textarea rows="3">${esc(text)}</textarea>`)}
        <div class="pending-files" data-files></div>
        <div class="send-actions"><button type="button" data-edit-cancel>Cancel</button>${sendButton('Save', 0)}</div></form>`;
  const cardHref = (key) => `#selectedCard=${encodeURIComponent(key)}`;
  const readsAt = (e) => `data-dismiss-new="${esc(e.key)}" data-at="${esc(e.at)}"`;
  // A New entry's footer opens with its time, as a thread message's does (ui-threads.js msgFooter), then the state words.
  const newTime = (iso) => `<span class="new-time">${esc(globalThis.BoardUI.time(iso))}</span>`;
  // docs/adr/2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md: a task the page hasn't sent yet
  // (app-threads.js unsentAsks) reads sending…, or not sent with Retry and X, as a thread message's footer does, with
  // no edit or delete. Its files still uploading or failed (e.uploads, attach.js's list under the box send:<send id>)
  // draw as upload tiles in a [data-uploads] box, whose X attach.js reads
  // (docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md).
  function newEntry(e, edit) {
    // Another board's question: who asked, linking the asking task, then waiting… or processing... as an ask reads; no
    // edit or delete, as the orchestrator answers it.
    if (e.question) {
      const q = e.question;
      const line = [`<a class="new-source" href="${esc(q.from.link)}">Asked from ${esc(q.from.words)}</a>`, q.state === 'working' ? processing(q.since) : PICKUP_WAIT].join(' · ');
      return `<div class="new-entry new-question" data-new="${esc(e.id)}"><div class="new-msg">${esc(e.text)}</div><div class="new-line sub">${newTime(e.sent)} · ${line}</div></div>`;
    }
    if (e.unsent) {
      const files = e.uploads ? `<div data-uploads="${esc(e.uploads.box)}">${globalThis.BoardUI.uploadTiles(e.uploads.list)}</div>` : globalThis.BoardUI.attachments(e.files);
      return `<div class="new-entry" data-new="${esc(e.id)}" data-send="${esc(e.id)}"><div class="new-msg">${esc(e.text)}</div>${files}<div class="new-line sub">${newTime(e.sent)} · ${globalThis.BoardUI.pickUp(e.unsent)}</div></div>`;
    }
    const done = e.made || e.into;
    const actions = done ? `<button type="button" class="ghost icon new-dismiss" ${readsAt(e)} aria-label="Dismiss" title="Dismiss">${globalThis.BoardUI.DISMISS}</button>`
      : `${editButton(e.id)}${withdrawButton(e.id)}`;
    const line = e.made ? `<a class="new-link" href="${cardHref(e.key)}" ${readsAt(e)}>Ticket created: <b>${esc(e.made.ref)}</b>${globalThis.BoardUI.laneRing(e.lane)}</a>`
      : e.into ? `<a class="new-link" href="${cardHref(e.key)}" ${readsAt(e)}>Added to <b>${esc(e.into.ref)}</b>${globalThis.BoardUI.laneRing(e.lane)}</a>`
      : askLine(e.ask);
    const body = edit ? editForm(e.id, edit.text) : `<div class="new-msg">${esc(e.text)}</div>${e.note ? `<blockquote class="quote new-note">${esc(e.note)}</blockquote>` : ''}${globalThis.BoardUI.attachments(e.files)}`;
    return `<div class="new-entry" data-new="${esc(e.id)}" data-key="${esc(e.key)}"><div class="ask-actions">${actions}</div>${body}<div class="new-line sub${done ? ' new-done' : ''}">${[newTime(e.sent), line].filter(Boolean).join(' · ')}</div></div>`;
  }
  // docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md
  // A hub Routed row (hub/router.mjs routedRows), drawn as a New entry with no actions: a blue link to the card it
  // became, was added to, or a later ask move sent it to, then a muted line with who sent it, from where, when and the
  // router's reason. One still queued reads waiting….
  const VIA = { slack: 'Slack' };
  function routedEntry(r) {
    const to = r.moved || r.to;
    const words = r.moved ? 'Moved to' : to?.into ? 'Added to' : 'Routed to';
    const line = r.waiting ? PICKUP_WAIT
      : `<a class="new-link" href="${esc(to.href)}">${words} <b>/${esc(to.route)}${to.ref ? ` ${esc(to.ref)}` : ''}</b>${to.title ? ` · ${esc(to.title)}` : ''}</a>`;
    const why = r.waiting ? '' : r.moved ? ` — was routed to /${r.to.route}: ${r.reason}` : ` — ${r.reason}`;
    return `<div class="new-entry" data-new="${esc(r.id)}"><div class="new-msg">${esc(r.text)}</div><div class="new-line sub${r.waiting ? '' : ' new-done'}">${newTime(r.at)} · ${line}</div>`
      + `<div class="new-line sub new-why">${esc([r.by, VIA[r.via] || r.via].filter(Boolean).join(' · '))}${esc(why)}</div></div>`;
  }
  // entries: newEntries, or {id, routed} for the hub's Routed rows; edits: app-asks.js's state.edits, by ask id. label
  // heads it, New on a board; empty is what an empty strip says, which a board's never draws.
  const newStrip = (entries, edits, { label = 'New', empty = '' } = {}) => `<div class="new-head"><span class="lane-name">${esc(label)}</span><span class="count">${entries.length}</span></div>
    <div class="new-list">${entries.length ? entries.map((e) => (e.routed ? routedEntry(e.routed) : newEntry(e, edits.get(e.id)))).join('') : `<div class="new-entry new-empty">${esc(empty)}</div>`}</div>`;

  const RISK_TONES = { low: 'ready', medium: 'notice', high: 'danger' };
  function workLines(it, { unread = 0 } = {}) {
    const ids = it.ticket ? ticketChip(it) : it.internal ? badge('quiet', esc(it.ref), { title: 'Work on this site, not a product PR' }) : it.linear?.length ? linearChips(it) : taskChip(it);
    // A card shows its ticket, or Task when it has none.
    const chips = `${prChips(it)}${commitChip(it)}${reviewChips(it)}${installChip(it)}`;
    // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md: preheating, planning prototype
    // or planning visual while the orchestrator writes the brief, generating visual while a visual agent draws, in blue.
    const status = it.planning && !it.builder ?`<div class="line3 sub agent planner">${DOT}${esc(it.planning)}</div>`
      : it.land ? landStatus(it)
      : it.orchestrator && !it.builder ? `${it.rebaseFailed ? `<div class="line3 sub">${escText(it.rebaseFailed)}</div>` : ''}${orchestratorStatus(it)}`
      : it.waitsOn === 'checking' ? `<div class="line3 sub agent${tone(it)}">${DOT}Orchestrator review</div>`
      : it.builder ? builderStatus(it)
      : it.refusal ? `<div class="line3 sub refused">${escText(it.refusal)}</div>`
      : it.landStopped ? `<div class="line3 sub">${escText(withCount(it.landStopped.words, it.landStopped.at))}</div>`
      : it.working ? `<div class="line3 sub agent">${thinkingLine(it.workingSince)}</div>`
      : it.next ? `<div class="line3 sub next${it.lane === 'todo' || it.lane === 'done' || it.held ? ' idle' : ''}">Next: ${escText(it.next)}</div>` : '';
    const eta = it.eta && it.builder ? `<div class="line3 sub eta">${escText(etaLine(it.eta))}</div>` : '';
    // The owner step's code check, which closes the card when it passes (docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md).
    const check = !it.ownerCheck ? '' : it.ownerCheck.broken ? `<div class="line3 sub refused">${escText(`Check can't run: ${it.ownerCheck.broken}`)}</div>`
      : `<div class="line3 sub check">${escText(`Checks: ${it.ownerCheck.words}`)}</div>`;
    return `${cardActions(it)}<div class="line1 title">${ids ? `${ids} ` : ''}${escText(it.title)}</div>
      ${status}${check}${eta}
      ${chips ? `<div class="line2 meta">${chips}</div>` : ''}
      ${timeLine(it, unread, progressBar(phaseStrip(it)))}`;
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
      <div class="line1 title">${badge('normal', `PR #${c.number}`)} ${escText(c.title)}</div>
      <div class="line3 sub${c.state === 'reviewing' ? ' agent' : ''}">${c.state === 'reviewing' ? '<span class="working-dot" aria-hidden="true"></span>' : ''}<span class="rv-word s-${c.state}">${REVIEW_WORDS[c.state]}</span> · ${esc(reviewWhen(c))}</div>
      <div class="line2 meta">${reviewChipsOf(c)}</div></div></summary>${reviewDetail(c)}</details>`;
  }
  const reviewLine = (c, open) => `<details class="rv-line" data-review="${c.number}"${open ? ' open' : ''}><summary><div class="title">${badge('normal', `PR #${c.number}`)} ${escText(c.title)}</div>
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

  Object.assign(globalThis.BoardUI, { prChips, commitChip, prName, linearChips, ticketChip, REVIEW, reviewAge, reviewChips, pendingQuestions, actionWords, blockedWords, tryWords, tryButton, mainBar, installChip, installButton, mergeButton, builderLine, BUILD_PHASES, phaseStrip, phaseMotion, unreadCount, heldUntilWords, holdPicker, workLines, RISK_TONES, newEntries, newStrip, askLine, reviewLane });
})();
