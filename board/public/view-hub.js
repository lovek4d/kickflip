// The hub page, /_hub/, a view of the app shell (shell.js): a banner while pushes are held or snoozed, the Usage card with Claude model and Codex share, Needs you for the pending
// prompts of sessions that own no board, Health, Integrations (readiness.mjs words), each site's health and board links,
// polling status, then hub settings summary rows (ADR 0075). A board's row can carry Restart (hub/restart-board.mjs). Health comes from GET /_hub/api/hub.
// Its data refreshes every 30 seconds while it shows (hub-kit.js live).
(function () {
  // The last data, which a return to the view paints at once.
  let last = null;
  const { esc } = HubUI;

  function rememberedHtml(sessions = []) {
    return sessions.map((s) => `<div class="remembered"><p>Always allow · session <code>${esc(s.session)}</code></p><ul>${s.rules.map((rule) => `<li><code>${esc(rule)}</code></li>`).join('')}</ul></div>`).join('');
  }

  const RESTARTING = '<span class="st wait">Restarting</span> · stopping its session, then starting it again';

  // A board with Restart (hub/restart-board.mjs restartable) keeps its link and chevron around the button, since a
  // button can't sit inside a link.
  function restartRow(s, sub, busy) {
    const href = esc(s.href);
    return `<div class="row site-row"><a class="site-link" href="${href}">${s.icon}<span class="text"><span class="title">${esc(s.title)}</span><span class="sub wrap">${sub}</span></span></a>`
      + `<button type="button" class="btn quiet restart-btn" data-restart="${esc(s.route)}" data-title="${esc(s.title)}" aria-label="Restart ${esc(s.title)}"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? '<span class="try-spin" aria-hidden="true"></span>Restarting…' : 'Restart'}</button>`
      + `<a class="chev" href="${href}" tabindex="-1" aria-hidden="true">›</a></div>`;
  }

  // restarting: the routes whose Restart is out.
  function sitesHtml(groups, restarting) {
    const { row, CHEVRON } = HubUI;
    const site = (s) => {
      const busy = restarting.has(s.route);
      const lines = s.lines.length ? `<span class="links">${s.lines.map((l) => `<span><b>${esc(l.link)}</b> ${esc(l.detail)}</span>`).join('')}</span>` : '';
      const sub = busy ? RESTARTING : `<span class="st ${esc(s.tone)}">${esc(s.word)}</span>${lines}`;
      return (s.restart ? restartRow(s, sub, busy) : row({ icon: s.icon, title: esc(s.title), sub, wrap: true, trail: CHEVRON, href: s.href })) + rememberedHtml(s.remembered);
    };
    return groups.map((g) => `<h2 class="label">${esc(g.label)}</h2>\n<div class="group">${g.sites.map(site).join('')}</div>\n`).join('');
  }

  function integrationsHtml(integrations) {
    const { row, tile } = HubUI;
    const fixHtml = (fix) => fix.command ? `<code>${esc(fix.command)}</code>` : fix.settings
      ? `${esc(fix.text)} <button type="button" class="link" data-settings-open="${esc(fix.settings)}">${esc(fix.label)}</button>.` : esc(fix.text);
    const rows = integrations.map((it) => row({ icon: tile(it.id, it.ready ? 'var(--color-quiet)' : 'var(--color-notice)'), title: esc(it.name), wrap: true,
      sub: it.ready ? `<span class="st ok">Ready</span> · ${esc(it.detail)}`
        : `<span class="st wait">Not ready</span> · ${esc(it.missing)}<span class="links"><span class="rd-fix">${fixHtml(it.fix)}</span><span class="rd-waits">${esc(it.waits)}</span></span>` })).join('');
    return `<h2 class="label" id="integrations">Integrations</h2><div class="group">${rows}</div>
<p class="note">A feature that needs an integration stays off until it’s ready, and says why.</p>
`;
  }

  // A pending prompt from a session that owns no board waits here (prompts.js).
  function promptsHtml(list, prompts) {
    const shown = list.filter(prompts.shows);
    return shown.length ? `<section class="waiting"><h2>Needs you · ${shown.length}</h2><ul>${shown.map((p) => BoardUI.promptItem(p, prompts.state(p))).join('')}</ul></section>` : '';
  }

  function html(d, { flash, prompts, restarting }) {
    const { row, tile, nowRow } = HubUI;
    const usage = HubUI.usageCard(d.usage, d.codex, d.pause, d.claude);
    return `${HubUI.flash(flash)}${HubUI.pauseBanner(d.pause)}${HubUI.holdBanner(d.hold)}${usage}${promptsHtml(d.prompts || [], prompts)}<h2 class="label"${usage ? '' : ' style="margin-top:4px"'}>Health</h2>
<div class="group">${row({ icon: tile('power', { ok: '#22c55e', wait: '#f59e0b' }[d.hub.tone] || '#ef4444'), title: 'Hub', sub: `<button type="button" class="st ${esc(d.hub.tone)}" data-jump="integrations">${esc(d.hub.word)}</button> ·${esc(d.hub.detail)}${d.awake ? `<span class="links"><span><span class="awake-on">Keeping awake</span> ${esc(d.awake)}</span></span>` : ''}`, wrap: true })}
${d.empty ? row({ title: 'No sites yet', sub: 'In a Claude session, run <code>/kickflip &lt;route&gt;</code>.' }) : ''}</div>
${integrationsHtml(d.integrations)}${sitesHtml(d.groups, restarting)}${d.remembered?.length ? `<h2 class="label">Sessions without a board</h2><div class="group">${rememberedHtml(d.remembered)}</div>` : ''}<p class="note">The hub runs every site and restarts one that stops. A board's links are what the hub owes it: GitHub polling, the fetch of its repo, events (its session and a watcher run, or the hub can wake it), daily wakes and reviewer links. One that just broke reads settling first.</p>
<h2 class="label">Polling status</h2>
<div class="group">${nowRow(d.polling, tile('clock', d.polling.count ? 'var(--color-notice)' : 'var(--color-quiet)'))}</div>`;
  }

  const footer = (d) => `<footer>${esc(d.sites)}. Each belongs to one Claude session, which adds it with <code>/kickflip &lt;route&gt;</code>. This page refreshes every 30 seconds.<br><span class="host">${esc(d.host)}</span></footer>`;

  // iOS shows an app badge only in a Home Screen app with notifications allowed; elsewhere this does nothing.
  function badge(n) {
    if (!('setAppBadge' in navigator)) return;
    try { (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch { /* not allowed here */ }
  }

  (globalThis.AppViews ||= {}).hub = {
    className: 'hub-view view-hub',
    title: () => 'Hub',
    markup: () => `${BoardUI.header({ lead: 'logo', title: 'Hub', time: 'now', logoSrc: '/_hub/kickflip.png', settingsHref: null })}
<main class="has-top"><div class="hub-status"></div><section class="hub-settings" aria-labelledby="hubSettingsLabel"><h2 class="label" id="hubSettingsLabel">Hub settings</h2>${HubSettings.markup()}</section><div class="hub-foot"></div></main>`,

    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const main = B.$('.hub-status');
      // A change in the Notifications modal can start or end the hold the banner shows.
      const settings = HubSettings.create(B.$('.hub-settings'), siteRoot, { ...ctx, sidebarChanged: () => { ctx.sidebarChanged?.(); load(); } });
      settings.mount();
      B.atUnmount(() => settings.unmount());
      B.on(B.$('#refresh'), 'click', () => settings.B.refreshSettings?.());
      let flash = null;
      const restarting = new Set();
      B.openSettings = (...args) => settings.B.openSettings(...args);
      async function restart(route, title) {
        if (restarting.has(route) || !(await BoardDialogs.confirm(`This stops ${title}’s session mid-task, along with any builder it started, then restarts its server and resumes the session. Its cards and threads stay. For a stuck board. Restart ${title}?`))) return;
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
        restarting.delete(route);
        if (B.alive()) { paint(); load(); }
      }
      B.on(main, 'click', (e) => {
        const opener = e.target.closest?.('[data-settings-open]');
        if (opener) B.openSettings({ hash: `#${opener.dataset.settingsOpen}` }, opener);
        // The Hub's status word jumps to what's behind it: Integrations, then each board's links below them.
        const jump = e.target.closest?.('[data-jump]');
        if (jump) B.$(`#${jump.dataset.jump}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
        const restarter = e.target.closest?.('[data-restart]');
        if (restarter) restart(restarter.dataset.restart, restarter.dataset.title);
      });
      const foot = B.$('.hub-foot');
      const paint = () => {
        if (!last) return;
        main.innerHTML = html(last, { flash, prompts, restarting });
        foot.innerHTML = footer(last);
      };
      const prompts = PromptAnswers.wire(B, {
        list: () => last?.prompts || [],
        paint,
        notify(text) { flash = { text, error: true }; paint(); },
        after: () => load(),
      });
      const forms = HubKit.forms(B, {
        accepts: (action, form) => action === '/_hub/push/flush' || ['/_hub/settings/codex', '/_hub/settings/claude-model', '/_hub/settings/pause-at', '/_hub/settings/keep-going'].includes(action) || Boolean(form?.closest?.('.hold-banner')),
        answer(out, action) {
          if (['/_hub/settings/codex', '/_hub/settings/claude-model', '/_hub/settings/pause-at', '/_hub/settings/keep-going'].includes(action)) {
            last = out; flash = null; paint();
            if (action.endsWith('/keep-going')) B.toast(out.pause.state === 'going' ? `Keep going: work runs past the buffer until ${BoardUI.usageClock(out.pause.resets_at)}.` : 'Stopped: new work waits again.');
          } else if (action === '/_hub/push/flush') { flash = { text: out.message, error: !out.ok }; load(); } else { flash = null; load(); settings.B.refreshSettings?.(); }
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
      });
      paint();
    }),
  };
})();
