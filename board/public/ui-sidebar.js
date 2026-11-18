// The sidebar of every site (docs/adr/2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md), drawn from the hub's
// /_hub/sidebar.json. It needs only ui-page-header.js, loaded before it, for its head, which is the page header itself,
// ui-progress-bar.js for a starting board's steps and ui-icon-text.js for every status's icon and word: the app shell runs
// it through sidebar.js, and hub/hub.mjs renders the shell's first sidebar with all four in a vm context.
// Its links are root-absolute, since every site and hub page sits beside this one on the hub. sidebar.css styles it.
(function () {
  // ui.js replaces the BoardUI global when it loads after this, so the header renderer is held here.
  const { header, progressBar, iconText } = globalThis.BoardUI || {};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (paths, size = 17) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    // A starting course's (hub/icons.mjs book).
    book: '<path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z"/><path d="M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z"/>',
    // A starting board's step icons, one per START_STEPS key. No open icon set (Lucide, Tabler) has a skateboard, so landing's
    // deck with upturned ends over two wheels is drawn here.
    cloning: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>',
    starting: '<path d="m5 7 5 5-5 5M12 18h7"/>',
    landing: '<path d="M2.5 9c0 1.7 1.2 3 3 3h13c1.8 0 3-1.3 3-3"/><circle cx="7.5" cy="16.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    up: '<circle cx="12" cy="12" r="9"/><path d="m8 12 4-4 4 4"/><path d="M12 16V8"/>',
  };
  const tile = (key, color) => `<span class="icon sm solid" style="--c:${color}" aria-hidden="true">${svg(ICONS[key])}</span>`;
  // A site row's status line from hub/home.mjs statusLine's data: the lane chips first, on their own line (sidebar.css .lcs),
  // then its icon and word, and (stale) beside them; a stale line reads flat grey with its pulse stilled.
  const siteLine = ({ status, stale, chips }) => {
    const lanes = chips === null ? '' : `<span class="lcs">${chips.length ? chips.map((c) => `<span class="lc lc-${esc(c.lane)}">${esc(c.text)}</span>`).join('') : '<span>nothing open</span>'}</span>`;
    const word = status ? iconText(stale ? 'dot' : status.shape, stale ? 'grey' : status.colour, status.word) : '';
    return `<span class="sb-status${stale ? ' stale' : ''}">${word}${stale ? '<span class="stale-word">(stale)</span>' : ''}${lanes}</span>`;
  };
  // hub/home.mjs hubHealth's tones, and the paused and busy ones the Hub row reads here, in the colour priority (AGENTS.md).
  const HUB_COLOURS = { down: 'red', wait: 'orange', ok: 'green', paused: 'grey' };
  const usageProducts = (data) => ['claude', 'codex'].filter((p) => data?.[p]);
  const usageNames = { claude: 'Claude', codex: 'Codex' };
  function usageClock(iso) {
    const d = new Date(iso ?? '');
    if (!Number.isFinite(d.getTime())) return '—';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M/i, (_, x) => `${x.toLowerCase()}m`);
    return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  // A pause's end in words: until its clock, or until you resume a Forever Pause hub or Pause board
  // (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md).
  const pauseUntilWords = (end) => (end === 'forever' ? 'until you resume' : `until ${usageClock(end)}`);
  const usageTone = (w) => w?.tone ?? 'none';
  const usageBar = (w) => `<span class="u-bar" aria-hidden="true"><i style="width:${w?.state === 'stale' ? 0 : Math.max(0, Math.min(100, w?.used_percentage || 0))}%"></i></span>`;
  function usageWords(reading, key) {
    const w = reading[key];
    if (!w) return 'No reading';
    if (w.state === 'stale') return `${Math.round(w.used_percentage)}% at ${esc(usageClock(reading.at))}`;
    if (w.state === 'reset') return `Reset ${esc(usageClock(w.resets_at))}`;
    return `<span class="u-num">${Math.round(w.used_percentage)}%</span> · resets ${esc(usageClock(w.resets_at))}`;
  }
  // Claude's week shows as a second bar when the gate sends a week tone (shared/usage-gate.mjs weekTone), its own colour.
  function weekBar(reading, tone) {
    if (!tone) return '';
    return `<span class="u-one u-tone-${tone}"><span class="u-line"><span class="u-name">Claude week</span> ${usageWords(reading, 'seven_day')}</span>${usageBar(reading.seven_day)}</span>`;
  }
  function sidebarUsage(data, weekTone) {
    const products = usageProducts(data);
    return products.length ? `<span class="sb-usage">${products.map((p) => {
      const r = data[p];
      const w = r.five_hour;
      const name = `<span class="u-name">${usageNames[p]}</span>`;
      const words = !w ? `${name} · no reading yet`
        : w.state === 'stale' ? `${name} · last seen ${esc(usageClock(r.at))}`
          : w.state === 'reset' ? `${name} · reset ${esc(usageClock(w.resets_at))}`
            : `${name} ${usageWords(r, 'five_hour')}`;
      return `<span class="u-one u-tone-${usageTone(w)}"><span class="u-line">${words}</span>${usageBar(w)}</span>${p === 'claude' ? weekBar(r, weekTone) : ''}`;
    }).join('')}</span>` : '';
  }
  // The utility rows, in the order they show.
  const UTILITY = [
    { href: '/_hub/', title: 'Hub', icon: tile('pulse', '#64748b') },
  ];
  const siteHref = (s) => `/${encodeURIComponent(s.route)}/`;

  // Switch mode's keys (sidebar.js; docs/adr/2026-10-30-1102-switch-mode-letters-come-from-names-in-join-order.md): each linked row the
  // sidebar draws, boards first for numbering, as {href, title, board, num, letter, at}. The first nine boards take num '1'–'9'.
  // Every row takes as letter the first a–z letter of its title not yet taken, at index `at` of the title's characters,
  // claiming in this order: boards by `created`, then pages by `created`, a site with none after those with one, then
  // the Hub rows. So a new board never takes another board's letter. A row with no letter left gets none.
  function switchKeys(data) {
    const sites = data?.sites || [];
    const site = (rank) => (s) => ({ href: siteHref(s), title: String(s.title ?? s.route), board: rank === 0, rank, joined: Date.parse(s.created) });
    const rows = [...sites.filter((s) => s.board).map(site(0)), ...sites.filter((s) => !s.board).map(site(1)),
      ...(data?.shared ? [] : UTILITY).map((f, i) => ({ href: f.href, title: f.title, board: false, rank: 2, joined: i }))];
    rows.filter((r) => r.board).slice(0, 9).forEach((r, i) => { r.num = String(i + 1); });
    const when = (r) => (Number.isFinite(r.joined) ? r.joined : Infinity);
    const taken = new Set();
    for (const r of [...rows].sort((a, b) => a.rank - b.rank || when(a) - when(b))) {
      const chars = [...r.title];
      const at = chars.findIndex((c) => /^[a-z]$/.test(c.toLowerCase()) && !taken.has(c.toLowerCase()));
      if (at < 0) continue;
      r.letter = chars[at].toLowerCase();
      r.at = at;
      taken.add(r.letter);
    }
    return rows.map(({ href, title, board, num, letter, at }) => ({ href, title, board, num, letter, at }));
  }

  // key: the row's switchKeys entry while switch mode shows, else undefined. The tile carries a board's number, or any
  // other row's letter, and the title marks its letter; sidebar.css shows them in place of the glyph under .ks-on.
  // mark: HTML after the title, such as Hub's moon.
  function row({ href, icon, title, sub = '', extra = '', mark = '', ctx = '', on = false, cls = '', key }) {
    const shown = key && (key.board ? key.num : key.letter);
    const tileHtml = shown ? icon.replace(/<\/span>$/, `<span class="ks-key">${esc(shown)}</span></span>`) : icon;
    const chars = [...title];
    const titleHtml = key?.letter ? `${esc(chars.slice(0, key.at).join(''))}<span class="ks-u">${esc(chars[key.at])}</span>${esc(chars.slice(key.at + 1).join(''))}` : esc(title);
    return `<a class="sb-row${on ? ' on' : ''}${cls ? ` ${cls}` : ''}" href="${esc(href)}"${on ? ' aria-current="page"' : ''}>${tileHtml}`
      + `<span class="sb-text">${ctx ? `<span class="sb-head"><span class="sb-title">${titleHtml}${mark}</span>${ctx}</span>` : `<span class="sb-title">${titleHtml}${mark}</span>`}${sub ? `<span class="sb-sub">${sub}</span>` : ''}${extra}</span></a>`;
  }

  // What waits on the owner on every site but `here`: the count on the logo that opens the drawer.
  function othersWaiting(data, here) {
    return (data?.sites || []).reduce((n, s) => n + (s.route === here ? 0 : Number(s.count) || 0), 0);
  }

  function repoLabel(repo, home) {
    if (!home) return repo;
    return repo === home ? '~' : repo.startsWith(`${home}/`) ? `~${repo.slice(home.length)}` : repo;
  }

  // The shortcuts sheet's rows (sidebar.js opens it on h h), grouped by where each key works. A new shortcut is added
  // here; the code that answers its key lives with the view it acts on.
  const SHORTCUTS = [
    { group: 'Anywhere', rows: [
      { keys: ['s', 's'], what: 'Switch boards and pages', sub: 'Then the key on a row' },
      { keys: ['h', 'h'], what: 'This help' },
      { keys: ['Esc'], what: 'Close', sub: 'The help, a sheet, the drawer or switch mode' },
    ] },
    { group: 'On a board', rows: [{ keys: ['n', 'n'], what: 'New task' }, { keys: ['f', 'f'], what: 'Search tasks', sub: 'Or /' }] },
    { group: 'Writing', rows: [{ keys: ['⌘', '↵'], what: 'Send', sub: 'Ctrl ↵ off a Mac' }] },
  ];
  // The shortcuts sheet's content, inside its <dialog aria-labelledby="shortcutsTitle">.
  function shortcuts() {
    const keycaps = (keys) => `<span class="sc-keys">${keys.map((k) => `<kbd class="sc-key">${esc(k)}</kbd>`).join('')}</span>`;
    const rowHtml = (r) => `<div class="sc-row"><span class="sc-what">${esc(r.what)}${r.sub ? `<span class="sc-sub">${esc(r.sub)}</span>` : ''}</span>${keycaps(r.keys)}</div>`;
    return `<div class="sheet-body"><div class="sheet-head"><h2 id="shortcutsTitle">Keyboard shortcuts</h2></div>`
      + SHORTCUTS.map((g) => `<section class="sc-group" aria-label="${esc(g.group)}"><h3>${esc(g.group)}</h3>${g.rows.map(rowHtml).join('')}</section>`).join('')
      + '<p class="sc-foot">Press h twice anywhere to open this. Esc to close.</p></div>';
  }

  const ticketsLabel = (t) => (t.source === 'github' ? `GitHub issues${t.account ? ` · ${t.account}` : ''}` : t.source === 'linear' ? `Linear · ${t.team}` : 'None');
  // A board's context window: its owner session's latest percent at the row's top right, red when the hub says it is full
  // (ctx.full), dimmed once the reading is older than ten minutes by this device's clock (an age), with that age in its tooltip.
  const CTX_STALE_MIN = 10;
  function contextWords(ctx) {
    if (!ctx) return '';
    const percent = Math.round(ctx.percent);
    const minutes = Math.floor((Date.now() - Date.parse(ctx.at)) / 60_000);
    const full = ctx.full ? ' full' : '';
    if (!(minutes >= CTX_STALE_MIN)) return `<span class="sb-ctx${full}" title="${percent}% of its context window">${percent}% ctx</span>`;
    const age = minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`;
    return `<span class="sb-ctx${full} stale" title="${percent}% of its context window, read ${age} ago">${percent}% ctx</span>`;
  }
  function askedWhen(iso, now) {
    const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : usageClock(iso);
  }
  // The sheet a failed start's row opens (sidebar.js), inside its <dialog aria-labelledby="failedStartTitle">: the error,
  // what the start used and when it was asked, then Dismiss and Retry. s: a /_hub/sidebar.json starting entry. Only a
  // New board start records a branch, and only that start can run again, so a row without one has no Retry.
  function failedStart(s, { home, now = Date.now() } = {}) {
    const fact = (name, value) => (value ? `<dt>${name}</dt><dd>${value}</dd>` : '');
    return `<div class="sheet-body"><div class="sheet-head"><h2 id="failedStartTitle">${esc(s.title)} failed to start</h2><button type="button" data-failed-close aria-label="Close sheet">✕</button></div>`
      + `<p class="fs-error">${esc(s.error || `Its session didn't answer within ${s.course ? 45 : 15} minutes.`)}</p>`
      + `<dl class="fs-facts">${fact('Repo', s.repo && esc(repoLabel(s.repo, home)))}${fact('Branch', s.branch && `<code>${esc(s.branch)}</code>`)}`
      + `${fact('Tickets', s.tickets && esc(ticketsLabel(s.tickets)))}${fact('Asked', s.askedAt && esc(askedWhen(s.askedAt, now)))}</dl>`
      + '<p class="fs-refused" role="alert" hidden></p>'
      + `<div class="sheet-actions fs-actions"><button type="button" data-failed-dismiss>Dismiss</button>${s.branch && !s.joined ? '<button type="button" class="primary" data-failed-retry>Retry</button>' : ''}</div></div>`;
  }

  // What's loading the host (docs/adr/2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md,
  // docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md), the sheet the Hub row's
  // status words open, from /_hub/machine.json (hub/machine-load.mjs machineLoad), or null while it loads: the load now
  // and its hour's average and line against the cores, then each group folded to its count and total CPU, each orphan
  // with Stop and its confirm in the row. open: the keys of the groups shown open, none as the sheet opens.
  const ageWords = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`);
  const tenth = (n) => Math.round(n * 10) / 10;
  function loadLine({ samples, cores }) {
    const h = 36;
    const top = Math.max(cores, ...samples.map((s) => s.load)) * 1.1;
    const y = (n) => tenth(h - (n / top) * h);
    const x = (i) => (samples.length > 1 ? tenth((i * 120) / (samples.length - 1)) : 120);
    return `<svg class="ls-spark" viewBox="0 0 120 ${h}" preserveAspectRatio="none" aria-hidden="true">`
      + `<line x1="0" x2="120" y1="${y(cores)}" y2="${y(cores)}" stroke="var(--line)" stroke-dasharray="3 3"/>`
      + `<polyline fill="none" stroke-width="2" vector-effect="non-scaling-stroke" points="${samples.map((s, i) => `${x(i)},${y(s.load)}`).join(' ')}"/></svg>`;
  }
  function loadSheet(data, { open = new Set() } = {}) {
    const head = `<div class="sheet-head"><h2 id="loadSheetTitle">What's loading the host</h2><button type="button" data-load-close aria-label="Close sheet">✕</button></div>`;
    if (!data) return `<div class="sheet-body">${head}<p class="ls-note" role="status">Reading the host…</p></div>`;
    const load = `<div class="ls-load${data.busy ? ' ls-busy' : ''}"><div><b>${tenth(data.load)}</b><span> now, ${data.cores} cores</span></div>`
      + (data.samples.length
        ? `<div><b class="ls-avg">${tenth(data.average)}</b><span> hour average</span></div><div class="ls-sparkbox">${loadLine(data)}<span class="ls-axis"><i>60 min ago</i><i>now</i></span></div>`
        : '<div><span>No samples yet</span></div>')
      + '</div>';
    const row = (r, orphan) => `<div class="ls-item"><div class="ls-row"><span class="ls-txt"><span class="ls-cmd">${esc(r.cmd)}</span><span class="ls-facts">${esc([ageWords(r.age), r.owner].filter(Boolean).join(' · '))}</span></span>`
      + `<span class="ls-cpu${r.cpu >= 100 ? ' hot' : ''}">${Math.round(r.cpu)}%</span>${orphan ? `<button type="button" class="ls-stop" data-stop="${r.pid}">Stop</button>` : ''}</div>`
      + (orphan ? `<div class="ls-confirm" hidden><span>Stop <code>${esc(r.cmd)}</code> (pid ${r.pid})? It ends the process and anything it's doing.</span><button type="button" data-keep>Keep</button><button type="button" class="danger" data-stop-yes="${r.pid}">Stop it</button><p class="ls-refused" role="alert" hidden></p></div>` : '')
      + '</div>';
    const groups = data.groups === null ? '<p class="ls-note">ps gave no answer in time, as happens on a busy host. Try again in a moment.</p>'
      : !data.groups.length ? '<p class="ls-note">Nothing is loading the host.</p>'
      : `<div class="ls-groups">${data.groups.map((g) => {
        const shown = open.has(g.key);
        const total = Math.round(g.rows.reduce((n, r) => n + r.cpu, 0));
        return `<div class="ls-group"><button type="button" class="ls-fold" data-fold="${esc(g.key)}" aria-expanded="${shown}"><span class="ls-chev" aria-hidden="true">›</span><span class="ls-name">${esc(g.title)}</span><span class="ls-sum">${g.rows.length} · ${total}%</span></button>`
          + `<div class="ls-inner"${shown ? '' : ' hidden'}>${g.rows.map((r) => row(r, g.key === 'orphan')).join('')}</div></div>`;
      }).join('')}</div>`;
    return `<div class="sheet-body">${head}${load}${groups}</div>`;
  }

  // A starting board's three steps (docs/adr/2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md):
  // s.step is cloning, starting (the orchestrator's session, until it joins the hub) or landing (the joined board, until it
  // listens), since s.stepAt.
  // Cloning fills its bar to git's percent; the later steps run the bars' pulse, never a fill.
  const START_STEPS = { cloning: 'cloning', starting: 'starting orchestrator', landing: 'landing it' };
  const STEP_KEYS = Object.keys(START_STEPS);
  // The lower row: the step, cloning with its percent, or the starting session's last activity in its place, and its
  // seconds; a stalled session's quiet minutes instead
  // (docs/adr/2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md). A host clock ahead of
  // this device's counts from 0s. A course (s.course) has the one step, writing lesson 1.
  function startCaption(s, now = Date.now()) {
    if (s.stalled) return `stalled · ${Math.max(0, Math.floor((now - Date.parse(s.quietSince)) / 60_000))}m quiet`;
    const seconds = Math.max(0, Math.floor((now - Date.parse(s.stepAt)) / 1000));
    return `${s.step === 'cloning' ? `cloning (${s.percent || 0}%)` : s.activity || (s.course ? 'writing lesson 1' : START_STEPS[s.step])} · ${seconds}s`;
  }
  // What follows a starting row's caption: Retry on a stalled New board start, or the red block of the prompt its
  // session waits on (hub/prompts.mjs shown), answered in place (sidebar.js): Allow once, Always and Deny, as a joined
  // board's strip has (ui-prompts.js promptStrip), a single one-pick question's
  // options and Skip, or a link to the hub page for a question that takes more.
  function startExtra(s) {
    if (s.stalled) return s.branch ? `<span class="sb-start-actions"><button type="button" class="sb-start-retry" data-start-retry="${esc(s.route)}">Retry</button></span>` : '';
    const p = s.prompt;
    if (!p) return '';
    const q = p.questions?.[0];
    const asks = q ? `asks: ${q.question}` : `${p.tool}: ${p.detail || p.action}`;
    const buttons = !q ? `<button type="button" class="primary" data-start-answer="allow">Allow once</button><button type="button" data-start-answer="always" data-start-rule="${esc(p.rule)}">Always</button><button type="button" class="deny" data-start-answer="deny">Deny</button>`
      : p.questions.length === 1 && !q.multiSelect ? `${q.options.map((o) => `<button type="button" data-start-question="${esc(q.question)}" data-start-option="${esc(o.label)}">${esc(o.label)}</button>`).join('')}<button type="button" class="deny" data-start-answer="deny">Skip</button>`
        : '<a href="/_hub/">Answer on the hub page</a>';
    return `<div class="sb-prompt" role="alert" data-start-prompt="${esc(p.id)}"><b>waiting on you · ${esc(asks)}</b><div class="sb-prompt-btns">${buttons}</div></div>`;
  }
  // docs/adr/2026-11-17-0254-a-new-board-opens-empty-while-its-orchestrator-starts.md
  // The banner across the top of a New board the hub serves while its orchestrator starts: the start's bars and
  // caption, as its sidebar row draws them, then the prompt its session waits on or a stalled start's Retry (startExtra),
  // orange while it works and red while the owner is needed; a failed start reads why, red, with Retry for a New board
  // start. Nothing once its session joins, or with no start (s undefined).
  function startBanner(s, now = Date.now()) {
    if (!s || s.joined) return '';
    const open = (tone) => `<div class="start-banner ${tone}" data-starting="${esc(s.route)}"><span class="sb-text">`;
    if (s.failed) {
      const retry = s.branch ? `<span class="sb-start-actions"><button type="button" class="sb-start-retry" data-start-retry="${esc(s.route)}">Retry</button></span>` : '';
      return `${open('down')}<b>orchestrator didn’t start</b><span class="sb-sub">${esc(s.error || 'failed to start')}</span>${retry}</span></div>`;
    }
    return `${open(s.prompt ? 'down' : 'wait')}<b>orchestrator starting</b>${startSteps(s)}<span class="sb-sub sb-step${s.stalled ? ' sb-stalled' : ''}">${esc(startCaption(s, now))}</span>${startExtra(s)}</span></div>`;
  }
  function startSteps(s) {
    const at = STEP_KEYS.indexOf(s.step);
    const label = `${START_STEPS[s.step]}, step ${at + 1} of ${STEP_KEYS.length}`;
    const count = STEP_KEYS.length;
    const bar = s.step === 'cloning' ? { count, done: 0, percent: s.percent || 0, label } : { count, done: at + 1, now: at, label };
    return `<span class="sb-steps">${progressBar(bar)}</span>`;
  }

  // The update row, only while the app's code is old: the version the hub now runs, as the Hub page's footer writes it (v0.5.1), or New version
  // when no version is known (a clone whose commit moved but not its version). update: the app's reload, null | 'ready' | 'reloading'. Nothing
  // else draws a row: the hub pulls a new version and restarts itself, and a pull or restart that fails shows nothing
  // (docs/adr/2026-11-06-0800-the-update-row-shows-only-new-version-and-reload.md). A reload waits (ui.js BUSY): the pill keeps
  // its blue with a spinner in place of its word.
  function updateRow(update, version = null) {
    if (!update) return '';
    return `<button type="button" class="sb-row sb-update-row" data-app-reload${update === 'reloading' ? globalThis.BoardUI.BUSY : ''}>${tile('up', 'var(--accent)')}`
      + `<span class="sb-text"><span class="sb-title">${version ? `v${esc(version)}` : 'New version'}</span></span><span class="sb-go">Reload</span></button>`;
  }

  // data: /_hub/sidebar.json. here: a site's route or a hub page's path without its leading slash. device: this device's push
  // subscription as sidebar.js finds it, 'on' | 'off' | 'blocked' | 'install' (iOS outside the Home Screen app), or
  // null while unknown or unsupported. switching: switch mode shows, each row with its key and the hint on the Boards label.
  // update: null | 'ready' | 'reloading'.  // now: the time a starting board's seconds count to. A shared person's data (data.shared; hub/share.mjs sharedSidebar)
  // draws their boards alone: no Hub row, update or notification rows, and no New.
  // Whether the Hub row reads busy: the hub's pause.machine.busy (hub/home.mjs sidebarPause).
  const hubBusy = (data) => Boolean(data?.pause?.machine?.busy);
  // The logo's one dot, the highest that applies (AGENTS.md colour order): 'down' (red) for a broken hub, Claude not listening on a
  // board, or this page unable to reach the host (offline, which only the page knows); 'busy' (orange); 'update' (blue, the page's
  // update is ready); 'paused' (grey); else ''
  // (docs/adr/2026-11-12-1000-the-logo-dot-carries-the-hub-state.md).
  const hubDot = (data, { offline = false, update = null } = {}) => {
    const deaf = (data?.sites || []).some((s) => s.board && (s.listen === 'deaf' || s.listen === 'full'));
    if (offline || deaf || data?.hub?.tone === 'down') return 'down';
    if (hubBusy(data)) return 'busy';
    if (update) return 'update';
    return data?.pause?.paused ? 'paused' : '';
  };

  function sidebar(data, { here = '', device = null, switching = false, update = null, now = Date.now() } = {}) {
    const sites = data?.sites || [];
    const keys = switching ? new Map(switchKeys(data).map((k) => [k.href, k])) : null;
    const paused = Boolean(data?.pause?.paused);
    // A busy host holds every board's new work but shows only on the Hub row and the logo's dot, never on a board, and a pause reads before it;
    // busy for a long while (pause.machine.banner) it also shows as a banner at the sidebar's top that opens the load sheet
    // (docs/adr/2026-11-06-1305-a-busy-host-shows-only-on-the-hub-row-and-the-logo-dot.md).
    const busy = hubBusy(data);
    const busyBanner = data?.pause?.machine?.banner
      ? `<button type="button" class="sb-busy-banner" data-load-sheet aria-haspopup="dialog">${iconText('dot', HUB_COLOURS.wait, `Host busy ${globalThis.BoardUI.liveFor(data.pause.machine.since, now)}${data.pause.machine.reason ? `: ${esc(data.pause.machine.reason)}` : ''}`)}</button>`
      : '';
    // A board under Pause board carries its own pause (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md).
    // The hub sends a held board's row already grey paused, a red fault keeping its word (hub/home.mjs heldSite).
    const siteRow = (s) => row({ href: siteHref(s), icon: s.icon, title: s.title, sub: s.sub ? siteLine(s.sub) : '', ctx: contextWords(s.ctx), on: s.route === here, key: keys?.get(siteHref(s)) });
    const boards = sites.filter((s) => s.board);
    const pages = sites.filter((s) => !s.board);
    const plus = `<span class="icon sb-plus" aria-hidden="true">${svg(ICONS.plus, 20)}</span>`;
    // A starting row's title opens its board once the hub serves it (s.served), an empty board while its orchestrator starts.
    // A course's starting row (s.course; hub/new-course.mjs) ends the Pages group: its book, orange while /teach writes
    // lesson 1, with no step bars, and on a failure reads /teach failed.
    const failedRow = (s) => `<button type="button" class="sb-row sb-starting sb-failed" data-starting="${esc(s.route)}" data-failed-start="${esc(s.route)}" aria-haspopup="dialog">${plus}`
      + `<span class="sb-text"><span class="sb-title">${esc(s.title)}</span><span class="sb-sub">${s.course ? '/teach failed' : s.ended ? 'session ended' : 'failed to start'}</span></span></button>`;
    const courses = (data?.starting || []).filter((s) => s.course).map((s) => (s.failed ? failedRow(s)
      : `<div class="sb-row sb-starting sb-course" data-starting="${esc(s.route)}"><span class="icon sb-plus sb-start-icon" aria-hidden="true">${svg(ICONS.book, 20)}</span>`
        + `<span class="sb-text"><span class="sb-title">${esc(s.title)}</span><span class="sb-sub sb-step${s.stalled ? ' sb-stalled' : ''}">${iconText('dot', s.stalled ? 'grey' : 'orange', startCaption(s, now))}</span>${startExtra(s)}</span></div>`)).join('');
    const pending = (data?.starting || []).filter((s) => !s.course).map((s) => (s.failed
      ? failedRow(s)
      : `<div class="sb-row sb-starting${s.route === here ? ' on' : ''}" data-starting="${esc(s.route)}"${s.route === here ? ' aria-current="page"' : ''}><span class="icon sb-plus sb-start-icon" aria-hidden="true">${svg(ICONS[s.step], 20)}</span>`
        + `<span class="sb-text">${s.served ? `<a class="sb-title" href="/${esc(s.route)}/">${esc(s.title)}</a>` : `<span class="sb-title">${esc(s.title)}</span>`}${startSteps(s)}<span class="sb-sub sb-step${s.stalled ? ' sb-stalled' : ''}">${esc(startCaption(s, now))}</span>${startExtra(s)}</span></div>`)).join('');
    const newBoard = `<button type="button" class="sb-row sb-new" data-new-board aria-haspopup="dialog">${plus}<span class="sb-text"><span class="sb-title">New</span></span></button>`;
    const turnOn = device === 'off' ? row({ href: '/_hub/#notifications', icon: tile('bell', 'var(--accent)'), title: 'Turn on notifications', sub: 'Off on this device', cls: 'sb-turnon' })
      : device === 'install' ? row({ href: '/_hub/#notifications', icon: tile('bell', 'var(--accent)'), title: 'Add Claude to your Home Screen', sub: 'Notifications come only to the Home Screen app', cls: 'sb-turnon' })
      : '';
    const usage = sidebarUsage(data?.usage, data?.pause?.week);
    const hub = data?.hub?.tone === 'down' || data?.hub?.tone === 'wait' ? data.hub : paused ? { tone: 'paused', word: 'paused', detail: pauseUntilWords(data.pause.resets_at) } : busy ? { tone: 'wait', word: 'busy', detail: globalThis.BoardUI.liveFor(data.pause.machine.since, now) } : data?.hub;
    const n = data?.notifications || {};
    const lower = (text) => String(text || '').replace(/^\w/, (c) => c.toLowerCase());
    // Notifications that can't reach the owner need them now: red (AGENTS.md).
    const notify = device === 'blocked' ? iconText('dot', 'red', 'Notifications blocked on this device')
      : n.state === 'off' ? iconText('dot', 'red', `Notifications ${lower(n.text || 'Off')}`) : '';
    // A phone shows no title tooltip, so there the moon only marks the hold; the hub page's banner says it.
    const hold = esc(`Notifications ${lower(n.text)}`);
    const moon = n.state === 'held' ? `<span class="sb-moon" role="img" aria-label="${hold}" title="${hold}">${svg(ICONS.moon, 13)}</span>` : '';
    const subs = {
      // The status words, whatever they say, open what's loading the host (loadSheet; sidebar.js), and the rest of the row the hub page.
      '/_hub/': (hub ? `<span class="sb-status sb-load" data-load-sheet role="button" tabindex="0" aria-label="${esc([hub.word, hub.detail].filter(Boolean).join(' '))}, what's loading the host" aria-haspopup="dialog">${iconText('dot', HUB_COLOURS[hub.tone], hub.word)}${hub.detail ? `<span>${esc(hub.detail)}</span>` : ''}</span>` : '')
        + (notify ? `<span class="sb-status">${notify}</span>` : ''),
    };
    const selected = here.startsWith('_hub') ? '/_hub' : `/${here.replace(/\/$/, '')}`;
    const hint = switching ? '<span class="ks-label-hint" role="status">– press a key to switch<i class="ks-bar"></i></span>' : '';
    const close = `<div class="nav"><button type="button" class="sb-close" data-sidebar-close aria-label="Close boards">${svg(ICONS.close, 20)}</button></div>`;
    const top = header({ lead: 'logo', title: 'Kickflip', level: 2, controls: false, trail: close, logoSrc: '/_hub/kickflip.png',
      leadAttrs: { 'aria-label': 'Hide boards', title: 'Hide boards', 'data-sidebar-close': '' } });
    const boardsLabel = `<div class="sb-label ks-label"><span class="ks-label-text">Boards</span>${hint}</div>`;
    if (data?.shared) return `${top}<div class="sb-scroll"><section class="sb-boards" aria-label="Boards">${boardsLabel}<div class="sb-group">${boards.map(siteRow).join('')}</div></section></div>`;
    return top
      + `<div class="sb-scroll">${busyBanner}<section class="sb-utility" aria-label="Hub"><div class="sb-update" role="status">${updateRow(update)}</div><div class="sb-group">`
      + UTILITY.map((f) => row({ ...f, on: f.href.replace(/\/$/, '') === selected, sub: subs[f.href], mark: f.href === '/_hub/' ? moon : '', ...(f.href === '/_hub/' && usage ? { extra: usage, cls: 'sb-hub-usage' } : {}), key: keys?.get(f.href) })).join('')
      + `</div>${turnOn}</section>`
      + (pages.length || courses ? `<section class="sb-pages" aria-label="Pages"><div class="sb-label">Pages</div><div class="sb-group">${pages.map(siteRow).join('')}${courses}</div></section>` : '')
      + `<section class="sb-boards" aria-label="Boards">${boardsLabel}`
      + `<div class="sb-group">${boards.map(siteRow).join('')}${pending}${newBoard}</div></section></div>`;
  }

  Object.assign(globalThis.BoardUI ||= {}, { sidebar, failedStart, loadSheet, START_STEPS, startSteps, startCaption, startBanner, updateRow, othersWaiting, switchKeys, shortcuts, repoLabel, usageProducts, usageNames, usageClock, pauseUntilWords, usageTone, usageBar, usageWords, hubDot });
})();
