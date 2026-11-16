// The hub page, /_hub/, a view of the app shell (shell.js): a banner while pushes are held or snoozed, the Usage card with Claude model and Codex share, Needs you for the pending
// prompts of sessions that own no board, Health, Integrations (readiness.mjs words), each site's health and board links
// with the New strip after the boards, then hub settings summary rows ([hub settings open as modals](docs/adr/2026-11-01-1221-hub-settings-open-as-modals.md)). Health carries the Keep awake toggle, and Linear's and Slack's Integrations rows
// a button that opens their key modal ([Linear and Slack keys open in modals from their Integrations rows](docs/adr/2026-11-09-2230-linear-and-slack-keys-open-in-modals-from-their-integrations-rows.md)). A board's row can carry Restart (hub/restart-board.mjs), and
// the Hub row Restart hub while the hub runs older code than its files. Health comes from GET /_hub/api/hub.
// Its data refreshes every 30 seconds while it shows (hub-kit.js live).
(function () {
  // The last data, which a return to the view paints at once.
  let last = null;
  const { esc } = HubUI;

  function rememberedHtml(sessions = []) {
    return sessions.map((s) => `<div class="remembered"><p>Always allow · session <code>${esc(s.session)}</code></p><ul>${s.rules.map((rule) => `<li><code>${esc(rule)}</code></li>`).join('')}</ul></div>`).join('');
  }

  const RESTARTING = '<span class="st wait">restarting</span> · stopping its session, then starting it again';

  // A board with Restart (hub/restart-board.mjs restartable) keeps its link and chevron around the button, since a
  // button can't sit inside a link. Restart waits (ui.js BUSY) until its POST answers, once the board is back up.
  function restartRow(s, sub, busy) {
    const href = esc(s.href);
    return `<div class="row site-row"><a class="site-link" href="${href}">${s.icon}<span class="text"><span class="title">${esc(s.title)}</span><span class="sub wrap">${sub}</span></span></a>`
      + `<button type="button" class="btn quiet restart-btn" data-restart="${esc(s.route)}" data-title="${esc(s.title)}" aria-label="Restart ${esc(s.title)}"${busy ? BoardUI.BUSY : ''}>Restart</button>`
      + `<a class="chev" href="${href}" tabindex="-1" aria-hidden="true">›</a></div>`;
  }

  // docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md: the requests the hub's router
  // filed on a board and the asks other boards put to one (hub/router.mjs routedRows), newest first, on the board's own New strip.
  // unsent: the page outbox's rows the hub doesn't list yet, first (ui-cards.js newEntry).
  const routedHtml = (rows, unsent) => `<section class="new-strip routed" aria-label="New">${BoardUI.newStrip([...unsent, ...rows.map((routed) => ({ id: routed.id, routed }))], new Map(),
    { label: 'New', empty: 'Nothing new yet. A Slack @kickflip request, a task from the + button or another board’s ask shows here.' })}</section>\n`;

  // restarting: the routes whose Restart is out; routed: the Routed section's rows, drawn after the Boards group, the
  // unsent rows first.
  function sitesHtml(groups, restarting, routed, unsent) {
    const { row, CHEVRON } = HubUI;
    const site = (s) => {
      const busy = restarting.has(s.route);
      const lines = s.lines.length ? `<span class="links">${s.lines.map((l) => `<span><b>${esc(l.link)}</b> ${esc(l.detail)}</span>`).join('')}</span>` : '';
      const sub = busy ? RESTARTING : `<span class="st ${esc(s.tone)}">${esc(s.word)}</span>${lines}`;
      return (s.restart ? restartRow(s, sub, busy) : row({ icon: s.icon, title: esc(s.title), sub, wrap: true, trail: CHEVRON, href: s.href })) + rememberedHtml(s.remembered);
    };
    return groups.map((g) => `<h2 class="label">${esc(g.label)}</h2>\n<div class="group">${g.sites.map(site).join('')}</div>\n${g.label === 'Boards' ? routedHtml(routed, unsent) : ''}`).join('');
  }

  // One helper for every integration's missing permissions (docs/adr/2026-11-15-0730-an-integration-missing-a-permission-reads-degraded.md):
  // it takes the row's {id, name, permissions: {missing: [{scope, effect}], fix}, keyButton} and draws the amber degraded
  // word on the row and the sheet the word opens: one line per missing permission naming what stops working, its scope in
  // mono, then the one fix and the integration's key button.
  const permissionsWord = (it) => `<button type="button" class="st wait" data-permissions="${esc(it.id)}" aria-haspopup="dialog">degraded</button>`;
  const permissionsSheet = (it) => `<div class="sheet-body"><div class="sheet-head"><h2 id="permissionsTitle">${esc(it.name)} is missing permissions</h2><button type="button" class="ghost" data-sheet-close aria-label="Close sheet">✕</button></div>
<ul class="mp-list">${it.permissions.missing.map((p) => `<li><span>${esc(p.effect)}</span> <code>${esc(p.scope)}</code></li>`).join('')}</ul>
<p class="mp-fix">${esc(it.permissions.fix)}</p>${it.keyButton ? `<button type="button" class="btn" data-settings-open="${esc(it.id)}" aria-haspopup="dialog">${esc(it.keyButton)}</button>` : ''}</div>`;

  function integrationsHtml(integrations) {
    const { row, tile } = HubUI;
    const fixHtml = (fix) => fix.command ? `<code>${esc(fix.command)}</code>` : fix.settings
      ? `${esc(fix.text)} <button type="button" class="link" data-settings-open="${esc(fix.settings)}">${esc(fix.label)}</button>.` : esc(fix.text);
    // One line per device with notifications on: kind, browser, last seen, and a Remove that forgets it.
    const mine = (() => { try { return localStorage.getItem('kickflip.push.id'); } catch { return null; } })();
    const deviceLine = (d) => `<span class="rd-device">${esc([d.kind, d.browser, `seen ${BoardUI.ago(d.added)}`].filter(Boolean).join(' · '))}${d.id === mine ? ' · <b>this device</b>' : ''} <button type="button" class="link" data-forget-device="${esc(d.id)}">Remove</button></span>`;
    const devices = (it) => it.devices?.length ? `<span class="links">${it.devices.map(deviceLine).join('')}</span>` : '';
    // Linear and Slack carry a key button instead of a fix, in both states.
    const keyButton = (it) => it.keyButton ? `<button type="button" class="btn quiet" data-settings-open="${esc(it.id)}" aria-haspopup="dialog">${esc(it.keyButton)}</button>` : '';
    const missingLinks = (it) => it.fix || it.waits
      ? `<span class="links">${it.fix ? `<span class="rd-fix">${fixHtml(it.fix)}</span>` : ''}${it.waits ? `<span class="rd-waits">${esc(it.waits)}</span>` : ''}</span>` : '';
    // GitHub's row while its rate limit holds is red, a fault, and says when it resets
    // (docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md).
    // A ready integration missing a permission reads amber degraded, the word opening its permissions sheet.
    const tone = (it) => it.limited || it.refused ? 'var(--color-danger)' : it.ready && !it.permissions ? 'var(--color-quiet)' : 'var(--color-notice)';
    const rows = integrations.map((it) => row({ icon: tile(it.id, tone(it)), title: esc(it.name), wrap: true, trail: keyButton(it),
      sub: it.ready ? `${it.permissions ? permissionsWord(it) : '<span class="st ok">ready</span>'} · ${esc(it.detail)}${devices(it)}`
        : `${it.limited ? '<span class="st down">rate limited</span>' : `<span class="st ${it.refused ? 'down' : 'wait'}">not ready</span>`} · ${esc(it.missing)}${missingLinks(it)}` })).join('');
    return `<h2 class="label" id="integrations">Integrations</h2><div class="group">${rows}</div>
<p class="note">A feature that needs an integration stays off until it’s ready, and says why.</p>
`;
  }

  // Keep awake (docs/adr/2026-11-09-1200-keep-awake-is-a-toggle-that-holds-the-mac-awake-only-on-ac-power.md): grey while off, orange while on as the machine working
  // (docs/adr/2026-11-01-1817-colour-says-whos-waiting.md). Unchecked posts nothing, which the hub reads as off. Off macOS it says why instead of a toggle.
  const AWAKE_NOTE = 'Runs <code>caffeinate -s</code> on the host so it doesn’t sleep while boards work, only while it is on AC power. On battery it holds nothing. The screen can still turn off.';
  const awakeRow = (a) => a.unsupported
    ? HubUI.row({ icon: HubUI.tile('coffee', 'var(--color-quiet)'), title: 'Keep awake', sub: esc(a.unsupported), wrap: true, attrs: ' id="keep-awake"' })
    : `<form class="row field" id="keep-awake" method="post" action="/_hub/settings/keep-awake">${HubUI.tile('coffee', a.on ? 'var(--color-notice)' : 'var(--color-quiet)')}<label class="body"><span class="text"><span class="title">Keep awake</span><span class="sub wrap">${AWAKE_NOTE}</span></span><input type="checkbox" id="awake" name="keep_awake" value="on" class="toggle" data-submit${a.on ? ' checked' : ''}></label></form>`;

  // Every pending prompt waits here, a board session's naming its board (prompts.js).
  function promptsHtml(list, prompts) {
    const shown = list.filter(prompts.shows);
    return shown.length ? `<section class="waiting"><h2>Needs you · ${shown.length}</h2><ul>${shown.map((p) => BoardUI.promptItem(p, prompts.state(p))).join('')}</ul></section>` : '';
  }

  // Restart hub, while the hub runs older code than its files (hub/views.mjs hubView's hub.restart). It waits (ui.js BUSY)
  // from the tap until the hub answers with its new code and the page reloads.
  const restartHubButton = (busy) => `<button type="button" class="btn quiet restart-btn" id="restart-hub" data-restart-hub${busy ? BoardUI.BUSY : ''}>Restart hub</button>`;

  function html(d, { flash, prompts, restarting, restartingHub, unsent }) {
    const { row, tile } = HubUI;
    const usage = HubUI.usageCard(d.usage, d.codex, d.pause, d.claude);
    // The status word is plain text, except while the hub runs older code: then it opens the Restart hub confirm and waits like that button.
    const word = d.hub.restart
      ? `<button type="button" class="st ${esc(d.hub.tone)}" data-restart-hub${restartingHub ? BoardUI.BUSY : ''}>${esc(d.hub.word)}</button>`
      : `<span class="st ${esc(d.hub.tone)}">${esc(d.hub.word)}</span>`;
    return `${HubUI.flash(flash)}${HubUI.pauseBanner(d.pause)}${HubUI.holdBanner(d.hold)}${usage}${promptsHtml(d.prompts || [], prompts)}<h2 class="label"${usage ? '' : ' style="margin-top:4px"'}>Health</h2>
<div class="group">${row({ icon: tile('power', { ok: '#22c55e', wait: '#f59e0b' }[d.hub.tone] || '#ef4444'), title: 'Hub', sub: `${word} ·${esc(d.hub.detail)}`, wrap: true,
    trail: d.hub.restart ? restartHubButton(restartingHub) : '' })}
${HubUI.machineRow(d.pause.machine)}
${awakeRow(d.awake)}
${d.empty ? row({ title: 'No sites yet', sub: 'In a Claude session, run <code>/kickflip &lt;route&gt;</code>.' }) : ''}</div>
${integrationsHtml(d.integrations)}${sitesHtml(d.groups, restarting, d.routed || [], unsent)}${d.remembered?.length ? `<h2 class="label">Sessions without a board</h2><div class="group">${rememberedHtml(d.remembered)}</div>` : ''}<p class="note">The hub runs every site and restarts one that stops. A board's links are what the hub owes it: GitHub polling, the fetch of its repo, events (its session and a watcher run, or the hub can wake it), daily wakes and reviewer links. One that just broke reads settling first.</p>`;
  }

  // The version line is one button: a tap checks npm now and pulls what it finds (POST /_hub/check-update), answering in
  // place (updateNote). A newer version npm has shows beside the version, old > new (new), whatever the auto update box says.
  // The box sits on the line under it; a clone never pulls, so it has no box.
  const footer = (d, note = '') => {
    const { latest, auto, clone } = d.update;
    return `<footer><span class="host">${esc(d.host)}</span><button type="button" class="version" data-check-update>kickflip.sh / ${esc(d.version)}${latest ? ` &gt; <span class="new">${esc(latest)} (new)</span>` : ''}${note ? ` <span class="update-note${note.startsWith('pulling') ? ' pulling' : ''}" role="status">${esc(note)}</span>` : ''}</button>${clone ? '' : `<label class="auto-update"><input type="checkbox" data-auto-update${auto ? ' checked' : ''}> auto update</label>`}</footer>`;
  };
  // What the hub's answer to a version tap says (hub/upgrade.mjs check()).
  const updateNote = (out) => ({
    clone: `${out.commit} · pulls with main`,
    same: 'up to date',
    pulling: `pulling ${out.latest}…`,
    failed: `check failed: ${out.error}`,
  })[out.state];

  // iOS shows an app badge only in a Home Screen app with notifications allowed; elsewhere this does nothing.
  function badge(n) {
    if (!('setAppBadge' in navigator)) return;
    try { (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch { /* not allowed here */ }
  }

  (globalThis.AppViews ||= {}).hub = {
    className: 'hub-view view-hub',
    title: () => 'Hub',
    markup: () => `${BoardUI.header({ lead: 'logo', title: 'Hub', time: 'now', logoSrc: '/_hub/kickflip.png' })}
<main class="has-top"><div class="hub-status"></div><section class="hub-settings">${HubSettings.markup()}</section><div class="hub-foot"></div></main>
<dialog class="sheet permissions-sheet" aria-labelledby="permissionsTitle"></dialog>
${BoardNewTask.markup()}`,

    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const main = B.$('.hub-status');
      // A change in the Notifications modal can start or end the hold the banner shows.
      const settings = HubSettings.create(B.$('.hub-settings'), siteRoot, { ...ctx, sidebarChanged: () => { ctx.sidebarChanged?.(); load(); } });
      settings.mount();
      B.atUnmount(() => settings.unmount());
      B.on(B.$('#refresh'), 'click', () => settings.B.refreshSettings?.());
      // docs/adr/2026-11-16-0600-the-hubs-new-task-box-files-through-the-router.md: the board's + button and New task sheet
      // (new-task.js), whose send goes to the router (POST /_hub/route) instead of a board's outbox. Its files are up on the
      // hub first (POST /_hub/api/upload, attach.js).
      // docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md: a send goes through this page's own outbox,
      // kept in this browser, each {sendId, ts, text, files, fields?, uploads?, failed?}, as a board's does (app-threads.js):
      // its row leads the New strip at once, reading sending…, waiting for the host while the hub is out of reach, or not
      // sent with Retry and X, until the hub lists the request under its sendId. They go one at a time, in order, and once
      // the hub is back on their own; the hub queues a sendId once, so a resend never files a task twice.
      const site = B.site.root;
      const outbox = () => B.store.get('outbox', []);
      const setOutbox = (list) => { B.store.set('outbox', list); paint(); };
      const sendBox = (m) => `send:${m.sendId}`;
      let online = true;
      const unsentRows = () => outbox().filter((m) => !last?.routed?.some((r) => r.id === m.sendId))
        .map((m) => ({ id: m.sendId, sent: m.ts, text: m.text, files: m.files, unsent: { sendId: m.sendId, state: m.failed ? 'failed' : online ? 'sending' : 'held' },
          ...(m.uploads ? { uploads: { box: sendBox(m), list: BoardAttach.list(sendBox(m), site) } } : {}) }));
      B.atUnmount(BoardAttach.onChange((id) => {
        const m = outbox().find((o) => o.uploads && sendBox(o) === id);
        if (!m) return;
        const uploads = BoardAttach.saved(id, site);
        if (JSON.stringify(uploads) !== JSON.stringify(m.uploads)) setOutbox(outbox().map((o) => (o.sendId === m.sendId ? { ...o, uploads } : o)));
        else paint();
      }));
      const marked = (m, change) => setOutbox(outbox().map((o) => (o.sendId === m.sendId ? { ...o, ...change } : o)));
      const post = (m) => BoardUI.sendWithin(async (signal) => {
        const r = await fetch('/_hub/route', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ text: m.text, files: m.files, ...m.fields, sendId: m.sendId }), signal })
          .catch((e) => { throw signal.aborted ? e : Object.assign(e, { unreachable: true }); });
        if (!r.ok) throw Object.assign(new Error('The hub didn’t take the task.'), { status: r.status, reason: (await r.json().catch(() => null))?.error || '' });
      });
      let flushing = false;
      async function flush() {
        if (flushing) return;
        flushing = true;
        try {
          for (let m = outbox()[0]; m && !m.failed && online && B.alive(); m = outbox()[0]) {
            if (m.uploads) {
              const up = await BoardAttach.settled(sendBox(m), site);
              if (!B.alive()) return;
              if (!up) { marked(m, { failed: true }); continue; }
              const { uploads, ...rest } = m;
              m = { ...rest, files: BoardAttach.files(sendBox(m), site) };
              setOutbox(outbox().map((o) => (o.sendId === m.sendId ? m : o)));
              BoardAttach.clear(sendBox(m), site);
            }
            try { await post(m); } catch (e) {
              if (!B.alive()) return;
              if (e.unreachable) { online = false; paint(); break; }
              marked(m, { failed: true });
              B.toast(e.reason || (e.timedOut ? 'The hub didn’t answer in 15 s.' : e.message));
              continue;
            }
            // The row stays until the hub's list holds the request.
            await load();
            setOutbox(outbox().filter((o) => o.sendId !== m.sendId));
          }
        } finally { flushing = false; }
      }
      // The hub going out of reach or coming back (hub-kit.js live) redraws the rows, and once it is back sends them.
      const linkChanged = (on) => {
        if (on === online) return;
        online = on;
        paint();
        if (on) flush();
      };
      B.sendBox = sendBox;
      B.enqueue = (key, { text, attached, fields }) => {
        const m = { sendId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), text, files: [], ...(fields ? { fields } : {}) };
        if (attached) {
          BoardAttach.move(attached, sendBox(m), site);
          m.uploads = BoardAttach.saved(sendBox(m), site);
        }
        setOutbox([...outbox(), m]);
        flush();
      };
      // Retry sends a failed task again in place, X drops it and puts its text and files back in the New task box
      // (new-task.js reopenAsk), each after a confirm.
      B.on(root, 'click', async (ev) => {
        const b = ev.target.closest('.routed button[data-resend], .routed button[data-unsend]');
        if (!b) return;
        const retry = b.hasAttribute('data-resend');
        const sendId = retry ? b.dataset.resend : b.dataset.unsend;
        if (!(await BoardDialogs.confirm(retry ? 'Send this task again?' : 'Dismiss this task? Its text and files go back in the New task box.')) || !B.alive()) return;
        const m = outbox().find((o) => o.sendId === sendId);
        if (!m) return;
        if (retry) {
          marked(m, { failed: false });
          if (m.uploads) BoardAttach.retryFailed(sendBox(m), site);
          flush();
        } else {
          setOutbox(outbox().filter((o) => o.sendId !== sendId));
          B.reopenAsk(m);
        }
      });
      BoardNewTask.wire(B);
      let flash = null;
      const restarting = new Set();
      B.openSettings = (...args) => settings.B.openSettings(...args);
      async function restart(route, title) {
        if (restarting.has(route) || !(await BoardDialogs.confirm(`This stops ${title}’s session mid-task, along with any implementer it started, then restarts its server and resumes the session. Its tasks and threads stay. For a stuck board. Restart ${title}?`))) return;
        restarting.add(route);
        flash = null;
        paint();
        let out = null;
        try {
          const r = await fetch('/_hub/restart-board', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ route }) });
          out = await r.json().catch(() => null);
          if (!r.ok || !out) throw new Error();
          if (B.alive()) B.toast(`${out.title} is back up, and its session is listening.`);
        } catch { flash = { text: out?.error || `Could not restart ${title}. Is the host awake?`, error: true }; }
        // The row keeps its Restart busy until the hub's data shows the board's new word, and only a refusal loads after
        // (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
        if (!flash && B.alive()) await BoardUI.pending.within(load(), () => { B.toast('Still waiting on the board'); load(); });
        restarting.delete(route);
        if (B.alive()) { paint(); if (flash) load(); }
      }
      // Restart hub asks the host to restart the hub service (POST /_hub/restart-hub), then waits for the hub to answer
      // with other code than it ran (its x-hub-code) and reloads the app; past HUB_WAIT tries it says how to restart by hand.
      let restartingHub = false;
      const HUB_WAIT = 120;
      async function restartHub() {
        if (restartingHub || !(await BoardDialogs.confirm('This restarts the hub on the host so it runs the code in its files. Its pages stop answering until it’s back, then this page reloads. Restart the hub?'))) return;
        restartingHub = true;
        flash = null;
        paint();
        let out = null, before = null;
        try {
          const r = await fetch('/_hub/restart-hub', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
          out = await r.json().catch(() => null);
          if (!r.ok || !out) throw new Error();
          before = r.headers.get('x-hub-code');
        } catch {
          restartingHub = false;
          flash = { text: out?.error || 'Could not restart the hub. Is the host awake?', error: true };
          if (B.alive()) paint();
          return;
        }
        for (let i = 0; i < HUB_WAIT && B.alive(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            const r = await fetch('/_hub/api/hub', { cache: 'no-store', headers: { accept: 'application/json' } });
            const code = r.headers.get('x-hub-code');
            if (r.ok && code && code !== before) return AppShell.reload();
          } catch { /* the hub is down while it restarts */ }
        }
        restartingHub = false;
        flash = { text: `The hub hasn’t come back. On the host, run ${out.command}`, error: true };
        if (B.alive()) paint();
      }
      // A tap on the version asks the hub to check npm now and shows the answer beside it until the next paint of new data.
      let updateText = '';
      async function checkUpdate() {
        if (updateText === 'checking…') return;
        updateText = 'checking…';
        paint();
        try {
          const r = await fetch('/_hub/check-update', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
          const out = await r.json();
          if (!r.ok) throw new Error();
          updateText = updateNote(out);
        } catch { updateText = 'could not check. Is the host awake?'; }
        if (B.alive()) paint();
      }
      async function forgetDevice(id) {
        const out = await fetch('/_hub/push/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).then((r) => r.ok, () => false);
        if (!out) { flash = { text: 'Could not remove that device. Is the host awake?', error: true }; paint(); return; }
        load();
      }
      const sheet = B.$('.permissions-sheet');
      B.on(sheet, 'click', (e) => {
        const opener = e.target.closest?.('[data-settings-open]');
        if (opener || e.target.closest?.('[data-sheet-close]') || BoardUI.onBackdrop(e, sheet)) sheet.close();
        if (opener) B.openSettings({ hash: `#${opener.dataset.settingsOpen}` }, opener);
      });
      B.atUnmount(BoardUI.swipeToDismiss(sheet));
      B.on(main, 'click', (e) => {
        const word = e.target.closest?.('[data-permissions]');
        if (word) {
          sheet.innerHTML = permissionsSheet(last.integrations.find((it) => it.id === word.dataset.permissions));
          sheet.showModal();
        }
        const forgetter = e.target.closest?.('[data-forget-device]');
        if (forgetter) forgetDevice(forgetter.dataset.forgetDevice);
        const opener = e.target.closest?.('[data-settings-open]');
        if (opener) B.openSettings({ hash: `#${opener.dataset.settingsOpen}` }, opener);
        if (e.target.closest?.('[data-restart-hub]')) restartHub();
        const restarter = e.target.closest?.('[data-restart]');
        if (restarter) restart(restarter.dataset.restart, restarter.dataset.title);
      });
      const foot = B.$('.hub-foot');
      B.on(foot, 'click', (e) => { if (e.target.closest?.('[data-check-update]')) checkUpdate(); });
      B.on(foot, 'change', async (e) => {
        if (!e.target.matches?.('[data-auto-update]')) return;
        await fetch('/_hub/settings/auto-update', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ auto_update: e.target.checked ? 'on' : 'off' }) });
        load();
      });
      // A #keep-awake link scrolls to Health's Keep awake row once it is drawn.
      let scrollToAwake = ctx.view?.hash === '#keep-awake';
      const paint = () => {
        if (!last) return;
        main.innerHTML = html(last, { flash, prompts, restarting, restartingHub, unsent: unsentRows() });
        foot.innerHTML = footer(last, updateText);
        if (scrollToAwake) { scrollToAwake = false; B.$('#keep-awake')?.scrollIntoView(); }
      };
      const prompts = PromptAnswers.wire(B, {
        list: () => last?.prompts || [],
        paint,
        notify(text) { flash = { text, error: true }; paint(); },
        after: () => load(),
      });
      const forms = HubKit.forms(B, {
        accepts: (action, form) => ['/_hub/settings/codex', '/_hub/settings/claude-model', '/_hub/settings/pause-at', '/_hub/settings/keep-going', '/_hub/settings/keep-awake'].includes(action) || Boolean(form?.closest?.('.hold-banner')),
        answer(out, action) {
          if (['/_hub/settings/codex', '/_hub/settings/claude-model', '/_hub/settings/pause-at', '/_hub/settings/keep-going'].includes(action)) {
            last = out; flash = null; paint();
            if (action.endsWith('/keep-going')) {
              const { kind, until } = out.pause.banner;
              B.toast(kind === 'going' ? `Keep going: work runs past the buffer until ${BoardUI.usageClock(until)}.`
                : kind === 'near-going' ? `Keep going: tasks in progress back to the full cap until ${BoardUI.usageClock(until)}.`
                : kind === 'near' ? 'Stopped: parallel tasks in progress are reduced again.' : 'Stopped: new work waits again.');
            }
          } else { flash = null; load(); settings.B.refreshSettings?.(); }
          ctx.sidebarChanged?.();
        },
        fail(message) { flash = { text: message, error: true }; paint(); },
      });
      const load = HubKit.live(B, {
        url: () => '/_hub/api/hub',
        paint(d) {
          if (!d) { if (!last) main.innerHTML = '<p class="note">Offline. Is the host awake?</p>'; return; }
          last = d;
          paint();
          badge(Number(d.total) || 0);
        },
        busy: () => forms.busy() || Boolean(root.querySelector('[data-dirty]')) || Boolean(root.querySelector('dialog[open]')),
        linked: linkChanged,
      });
      paint();
      // Whatever a reload left in the outbox goes out again, a failed one included, its files back in its box.
      if (outbox().some((m) => m.failed)) setOutbox(outbox().map(({ failed, ...m }) => m));
      for (const m of outbox()) if (m.uploads && !BoardAttach.list(sendBox(m), site).length) BoardAttach.restore(sendBox(m), m.uploads, site);
      flush();
    }),
  };
})();
