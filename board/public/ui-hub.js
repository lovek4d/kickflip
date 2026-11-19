// The rows and tiles of the hub page and settings modals (view-hub.js, view-hub-settings.js), which hub.css styles
// under .hub-view. Pure: each lays out words hub/views.mjs wrote, and title and sub are HTML.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TILE_PATHS = {
    github: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/>',
    codex: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
    linear: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    slack: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    tailscale: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
    notifications: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    tests: '<path d="M9 3h6"/><path d="M10 3v7.5L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 10.5V3"/><path d="M7.5 15h9"/>',
    snooze: '<path d="M4 10h6l-6 8h6"/><path d="M14 4h6l-6 8h6"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2"/><path d="M10 2v2"/><path d="M14 2v2"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    merge: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M6 8.5a9 9 0 0 0 9.5 9.5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  };
  const tile = (key, color) => `<span class="icon sm solid" style="--c:${color}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TILE_PATHS[key]}</svg></span>`;
  const CHEVRON = '<span class="chev" aria-hidden="true">›</span>';

  function row({ icon = '', title, sub = '', wrap = false, trail = '', href, attrs = '' }) {
    const inner = `${icon}<span class="body"><span class="text"><span class="title">${title}</span>${sub ? `<span class="sub${wrap ? ' wrap' : ''}">${sub}</span>` : ''}</span>${trail}</span>`;
    return href ? `<a class="row" href="${esc(href)}"${attrs}>${inner}</a>` : `<div class="row"${attrs}>${inner}</div>`;
  }

  // flash: {text, error} or null, a form's answer shown above the view.
  const flash = (f) => (f ? `<div class="flash${f.error ? ' error' : ''}" role="${f.error ? 'alert' : 'status'}">${esc(f.text)}</div>` : '');

  // hold: hub/views.mjs hubView's hold, or null for no banner. Its End form posts snooze=off, which view-hub.js sends.
  const holdBanner = (hold) => (hold ? `<div class="hold-banner"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TILE_PATHS.moon}</svg><span>${esc(hold.text)}</span>${hold.end ? '<form method="post" action="/_hub/settings/notifications"><button class="btn quiet" name="snooze" value="off">End snooze</button></form>' : ''}</div>` : '');

  // pause: shared/usage-gate.mjs usageGate's gate, whose banner {kind, text, until} says what to draw: the text with
  // `{until}` in this browser's clock, and Resume (manual), Stop (going) or Keep going (paused, near)
  // (docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md).
  function pauseBanner(pause) {
    const banner = pause?.banner;
    if (!banner) return '';
    const going = banner.kind === 'going' || banner.kind === 'near-going';
    const until = BoardUI.usageClock(banner.until);
    const text = banner.text.replace('{until}', until);
    const icon = going ? '<path d="M3.34 19a10 10 0 1 1 17.32 0"/><path d="m12 14 4-4"/>' : '<circle cx="12" cy="12" r="9"/><path d="M10 9v6"/><path d="M14 9v6"/>';
    // Pause hub (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md): Resume ends it, which view-hub.js posts.
    if (banner.kind === 'manual') return `<div class="hold-banner ub-banner ub-paused" role="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span>${esc(text)}</span><form method="post" action="/_hub/settings/hub-pause"><button class="btn quiet" name="pause" value="off">Resume</button></form></div>`;
    return `<div class="hold-banner ub-banner ub-${going ? 'going' : 'paused'}" role="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span>${esc(text)}</span><form method="post" action="/_hub/settings/keep-going"><button class="btn quiet" name="value" value="${going ? 'off' : 'on'}">${going ? 'Stop' : 'Keep going'}</button></form></div>`;
  }

  // Health's Machine row: the gate's machine (shared/machine-gate.mjs), busy with its reason or normal, in words only
  // (docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md).
  const machineRow = (machine) => {
    const busy = machine.state === 'busy';
    return row({ icon: tile('power', busy ? '#f59e0b' : '#22c55e'), title: 'Machine', wrap: true,
      sub: busy ? `<span class="st wait">busy</span> · ${esc(machine.reason)}` : '<span class="st ok">normal</span>' });
  };

  // builder: the word for who builds Codex's work, hub/views.mjs hubView's claude.builder.
  function bufferControl(pause, builder) {
    const at = pause.pause_at;
    const off = at === 100;
    return `<div class="block"><div class="ub-row"><span class="ub-label"><span class="title">Pause work at</span><span class="ub-sub">${off ? 'No buffer' : `${100 - at}% buffer`}</span></span>`
      + `<form class="segments ub-step" method="post" action="/_hub/settings/pause-at" role="group" aria-label="Pause work at"><button name="value" value="${at - 5}" aria-label="Pause 5% sooner"${at <= 50 ? ' disabled' : ''}>−</button>`
      + `<output class="${off ? 'off' : ''}" aria-live="polite">${off ? 'Off' : `${at}%`}</output>`
      + `<button name="value" value="${at + 5}" aria-label="Pause 5% later"${off ? ' disabled' : ''}>+</button></form></div>`
      + `<p class="u-share-desc">${off ? 'Off: work keeps going until usage runs out.' : `Claude’s new work waits when either window passes this, and resumes at that window’s reset; Codex hands its work to ${builder} implementers.`}</p></div>`;
  }

  // This device's notifications (hub-kit.js device): state is {title, sub, action: {label, act, quiet, busy}} or null
  // while unknown, which keeps the row hidden. A busy action waits (ui.js BUSY) while it turns on or tests.
  function deviceRow(state, { compact = false } = {}) {
    if (!state) return `<div class="row" id="push" hidden>${tile('bell', 'var(--accent)')}</div>`;
    const a = state.action;
    const button = a ? `<button type="button" class="${a.quiet ? 'btn quiet' : 'btn'}" data-device="${esc(a.act)}"${a.busy ? BoardUI.BUSY : ''}>${esc(a.label)}</button>` : '';
    return `<div class="row" id="push">${tile('bell', state.action?.act === 'test' ? 'var(--color-success)' : 'var(--accent)')}<span class="body"><span class="text"><span class="title">${esc(state.title)}</span>${compact ? '' : `<span class="sub wrap">${esc(state.sub)}</span>`}</span>${compact && state.title === 'This device' ? `<span class="val">${state.sub?.startsWith('On') ? 'On' : 'Off'}</span>` : ''}${button}</span></div>`;
  }

  // The Codex share control: codex is hub/views.mjs hubView's codex, and its form posts to /_hub/settings/codex, which
  // view-hub.js sends. While Codex isn't usable the choices are disabled, with the reason and the command to run.
  function codexShare(codex) {
    const off = !codex.usable;
    const buttons = codex.choices.map((c) => `<button type="submit" name="value" value="${esc(c.value)}" aria-pressed="${c.on}"${off ? ' disabled' : ''}>${esc(c.label)}</button>`).join('');
    return `<div class="u-share"><form class="segments${off ? ' is-disabled' : ''}" method="post" action="/_hub/settings/codex" role="group" aria-label="Codex share"${off ? ' aria-disabled="true"' : ''}>${buttons}</form>`
      + `<p class="u-share-desc">${esc(codex.description)}</p>${codex.fix ? `<p class="u-share-fix"><code>${esc(codex.fix)}</code></p>` : ''}</div>`;
  }

  // The Builders or Orchestrators control in Hub settings' Usage card, drawn as Codex share's: model is a
  // shared/model-views.mjs view, and its form posts to action, which view-hub.js sends.
  function modelControl(model, action) {
    const buttons = model.choices.map((c) => `<button type="submit" name="value" value="${esc(c.value)}" aria-pressed="${c.on}">${esc(c.label)}</button>`).join('');
    return `<div class="u-share model-control"><span class="model-label">${esc(model.label)}</span><form class="segments model-seg" method="post" action="${esc(action)}" data-model="${esc(model.name)}" role="group" aria-label="${esc(model.label)}">${buttons}</form>`
      + `<p class="u-share-desc">${esc(model.description)}</p></div>`;
  }

  // A hub-wide number from 1 to 99, drawn as Pause work at's stepper: its form posts n's neighbour to action, which
  // view-hub.js sends.
  function countControl(title, n, action, desc) {
    return `<div class="block"><div class="ub-row"><span class="ub-label"><span class="title">${title}</span></span>`
      + `<form class="segments ub-step" method="post" action="${action}" role="group" aria-label="${title}"><button name="value" value="${n - 1}" aria-label="One fewer"${n <= 1 ? ' disabled' : ''}>−</button>`
      + `<output aria-live="polite">${n}</output>`
      + `<button name="value" value="${n + 1}" aria-label="One more"${n >= 99 ? ' disabled' : ''}>+</button></form></div>`
      + `<p class="u-share-desc">${desc}</p></div>`;
  }

  // docs/adr/2026-11-19-0602-one-hub-wide-build-cap-boards-take-turns.md,
  // docs/adr/2026-11-19-0800-every-hub-limit-takes-the-same-turns.md
  // The Capacity section, right below Usage: the hub's numbers every board shares, capacity being hub/views.mjs
  // hubView's capacity.
  const capacityCard = (capacity) => `<section class="capacity"><h2 class="label">Capacity</h2><div class="group">`
    + countControl('Maximum tasks in progress', capacity.tasksInProgress, '/_hub/settings/tasks-in-progress', 'Hub-wide. Each counts from its build starting until it lands. Boards take turns, one card each.')
    + countControl('Maximum parallel serves', capacity.serves, '/_hub/settings/serves', 'Hub-wide. Each open task worktree keeps one serve up. Installs aren’t counted. A busy host asks before it starts another. Boards take turns, one card each.')
    + countControl('Maximum parallel land tests', capacity.landTests, '/_hub/settings/land-tests', 'Hub-wide. Lands run the tests their change affects. Boards take turns, one card each.')
    + '</div></section>';

  // data is the usage reading; claude, when given, opens Claude's block with the Builders and Orchestrators controls,
  // even without a reading; codex, when given, draws Codex's block even without a reading: the Codex share control
  // first, then Codex's bars while share isn't Off.
  function usageCard(data, codex, pause, claude) {
    const { usageProducts, usageNames, usageClock, usageTone, usageBar, usageWords } = BoardUI;
    const products = usageProducts(data);
    if (claude && !products.includes('claude')) products.unshift('claude');
    if (codex && !products.includes('codex')) products.push('codex');
    if (!products.length) return '';
    const head = (name, tag) => `<div class="u-head"><span class="title">${name}</span>${tag ? `<span class="u-asof">${esc(tag)}</span>` : ''}</div>`;
    const asof = (r) => (!r.at ? 'no reading' : `${r.five_hour?.state === 'stale' ? 'last seen' : 'read'} ${usageClock(r.at)}`);
    const windows = (r) => [['5-hour', 'five_hour'], ['Week', 'seven_day']].map(([label, key]) =>
      `<div class="u-tone-${usageTone(r[key])}${pause?.pause_at < 100 ? ' ub-marked' : ''}"><div class="u-win"><span>${label}</span><span>${usageWords(r, key)}</span></div>${usageBar(r[key]).replace('</span>', `${pause?.pause_at < 100 ? `<span class="ub-mark" style="left:${pause.pause_at}%"></span>` : ''}</span>`)}</div>`).join('');
    const blocks = products.map((p) => {
      const r = data?.[p] || { at: null };
      if (p === 'claude' && claude) return `<div class="block u-block">${head(usageNames.claude, asof(r))}${modelControl(claude.builders, '/_hub/settings/claude-model')}${modelControl(claude.orchestrators, '/_hub/settings/orchestrator-model')}${windows(r)}</div>`;
      if (p !== 'codex' || !codex) return `<div class="block u-block">${head(usageNames[p], asof(r))}${windows(r)}</div>`;
      const bars = codex.usable && codex.share !== 'off';
      return `<div class="block u-block">${head(usageNames.codex, codex.tag || (bars ? asof(r) : ''))}${codexShare(codex)}${bars ? `<div class="u-codex-bars">${windows(r)}</div>` : ''}</div>`;
    }).join('');
    const buffer = pause && products.includes('claude') ? bufferControl(pause, claude?.builder ?? 'Claude') : '';
    return `<section class="usage"><h2 class="label" style="margin-top:4px">Usage</h2><div class="group">${blocks}${buffer}</div></section>`;
  }

  globalThis.HubUI = { esc, TILE_PATHS, tile, CHEVRON, row, flash, holdBanner, pauseBanner, machineRow, deviceRow, usageCard, capacityCard };
})();
