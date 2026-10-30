// The hub page, /_hub/, a view of the app shell (shell.js): the hub's health, each site's health and board links,
// polling, this device's notifications and the hub rules, in hub/views.mjs hubView's words from GET /_hub/api/hub.
// Its data refreshes every 30 seconds while it shows (hub-kit.js live).
(function () {
  // The last data, which a return to the view paints at once.
  let last = null;
  const { esc } = HubUI;

  function sitesHtml(groups) {
    const { row, CHEVRON } = HubUI;
    const site = (s) => {
      const lines = s.lines.length ? `<span class="links">${s.lines.map((l) => `<span><b>${esc(l.link)}</b> ${esc(l.detail)}</span>`).join('')}</span>` : '';
      return row({ icon: s.icon, title: esc(s.title), sub: `<span class="st ${esc(s.tone)}">${esc(s.word)}</span>${lines}`, wrap: true, trail: CHEVRON, href: s.href });
    };
    return groups.map((g) => `<h2 class="label">${esc(g.label)}</h2>\n<div class="group">${g.sites.map(site).join('')}</div>\n`).join('');
  }

  function html(d, { flash, device }) {
    const { row, tile, CHEVRON, nowRow, deviceRow } = HubUI;
    return `${HubUI.flash(flash)}<h2 class="label" style="margin-top:4px">Health</h2>
<div class="group">${row({ icon: tile('power', d.hub.tone === 'ok' ? '#22c55e' : '#ef4444'), title: 'Hub', sub: `<span class="st ${esc(d.hub.tone)}">${esc(d.hub.word)}</span> · ${esc(d.hub.detail)}`, wrap: true })}
${d.empty ? row({ title: 'No sites yet', sub: 'In a Claude session, run <code>/join-web-ts &lt;route&gt;</code>.' }) : ''}</div>
${sitesHtml(d.groups)}<p class="note">The hub runs every site and restarts one that stops. A board's links are what the hub owes it: GitHub polling, events (a watcher runs), daily wakes, pushes, reviewer links and hub code. One that just broke reads settling first.</p>
<h2 class="label">Polling</h2>
<div class="group">${nowRow(d.polling, tile('clock', '#3b82f6'))}
${row({ title: 'Windows, overnight hold, daily wakes', sub: esc(d.polling.summary), wrap: true, trail: CHEVRON, href: '/_hub/settings/polling' })}</div>
<h2 class="label">Notifications</h2>
<div class="group">${deviceRow(device.state(d.notifications.device))}
${row({ icon: tile('power', d.notifications.on ? '#22c55e' : '#6b7280'), title: 'Push notifications', sub: esc(d.notifications.text), trail: CHEVRON, href: '/_hub/settings' })}</div>
<h2 class="label">Every board</h2>
<div class="group">${row({ title: 'Rules for every board', sub: esc(d.rules), trail: CHEVRON, href: '/_hub/settings#rules' })}</div>
<footer>${esc(d.sites)}. Each belongs to one Claude session, which adds it with <code>/join-web-ts &lt;route&gt;</code>. This page refreshes every 30 seconds.<br><span class="host">${esc(d.host)}</span></footer>`;
  }

  // iOS shows an app badge only in a Home Screen app with notifications allowed; elsewhere this does nothing.
  function badge(n) {
    if (!('setAppBadge' in navigator)) return;
    try { (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch { /* not allowed here */ }
  }

  (globalThis.AppViews ||= {}).hub = {
    className: 'hub-view view-hub',
    title: () => 'Hub',
    markup: () => `${BoardUI.header({ lead: 'logo', title: 'Hub', time: 'now', logoSrc: '/_hub/kickflip.png', settingsHref: '/_hub/settings' })}
<main class="has-top"></main>`,

    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const main = B.$('main');
      let flash = null;
      const paint = () => { if (last) main.innerHTML = html(last, { flash, device }); };
      const device = HubKit.device(B, { paint, changed: () => ctx.sidebarChanged?.() });
      const forms = HubKit.forms(B, {
        answer(out) { flash = { text: out.message, error: !out.ok }; load(); ctx.sidebarChanged?.(); },
        fail(message) { flash = { text: message, error: true }; paint(); },
      });
      const load = HubKit.live(B, {
        url: () => '/_hub/api/hub',
        paint(d) {
          if (!d) { if (!last) main.innerHTML = '<p class="note">Offline. Is the Mac awake?</p>'; return; }
          last = d;
          paint();
          badge(Number(d.total) || 0);
        },
        busy: () => device.busy() || forms.busy() || Boolean(root.querySelector('dialog[open]')),
      });
      paint();
    }),
  };
})();
