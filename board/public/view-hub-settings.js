// Hub Settings, /_hub/settings, a view of the app shell (shell.js): notifications on or off, snooze, off on weekends,
// whether pushes go to the Mac only because the owner is at it, the polling summary, Codex setting and rules for every
// board, in hub/views.mjs settingsView's words from GET /_hub/api/settings.
// Each toggle and snooze posts to /_hub/settings/notifications and saves at once. The rules editor saves through POST
// /_hub/settings/rules and marks [data-dirty] while an edit is unsaved, so the shell asks before leaving then. The
// data refreshes every 30 seconds while nothing is being edited.
(function () {
  // The last data, which a return to the view paints at once.
  let last = null;
  const { esc } = HubUI;
  const ACTION = '/_hub/settings/notifications';

  function sheet(s) {
    const rows = s.choices.map((c) => `<button class="row" form="snoozePick" name="snooze" value="${esc(c.value)}"${c.disabled ? ' disabled' : ''}><span class="body"><span class="text title">${esc(c.label)}</span><span class="val">${esc(c.until)}</span></span></button>`).join('');
    return `<dialog class="sheet" id="snoozeSheet" aria-labelledby="snoozeTitle"><div class="sheet-body"><div class="grab" aria-hidden="true"></div><h2 id="snoozeTitle">${esc(s.title)}</h2>
<div class="group">${rows}<div class="row field"><input type="datetime-local" form="snoozeAt" name="snooze" required min="${esc(s.min)}" max="${esc(s.max)}" aria-label="Snooze until a date and time"><button class="btn" form="snoozeAt">Snooze</button></div></div>
<form id="snoozePick" method="post" action="${ACTION}"></form><form id="snoozeAt" method="post" action="${ACTION}"></form>
<form method="dialog"><button class="cancel">Cancel</button></form></div></dialog>`;
  }

  // The on/off, snooze and weekend rows (docs/adr/0032-notifications-can-be-off-snoozed-or-off-on-weekends.md).
  function notificationRows(d) {
    const { tile, CHEVRON } = HubUI;
    const toggle = ({ icon, set, title, sub, checked, attrs = '' }) => `<form class="row field" method="post" action="${ACTION}"><input type="hidden" name="set" value="${set}">${icon}<label class="body"><span class="text"><span class="title">${title}</span><span class="sub wrap">${esc(sub)}</span></span><input type="checkbox" name="value" value="on" class="toggle"${attrs}${checked ? ' checked' : ''}></label></form>`;
    const onRow = toggle({ icon: tile('power', d.on.on ? '#22c55e' : '#6b7280'), set: 'on', title: 'Push notifications', checked: d.on.on, sub: d.on.sub,
      attrs: ` id="notifyOn" data-confirm="${esc(d.on.confirm)}"` });
    const weekendRow = toggle({ icon: tile('calendar', '#0ea5e9'), set: 'weekends', title: 'Off on weekends', checked: d.weekends.on, attrs: ' data-submit', sub: d.weekends.sub });
    const snoozeRow = !d.snooze ? '' : `<button class="row" type="button" data-snooze-open aria-haspopup="dialog">${tile('snooze', '#a855f7')}<span class="body"><span class="text"><span class="title">Snooze</span><span class="sub wrap">${esc(d.snooze.sub)}</span></span><span class="val">${esc(d.snooze.value)}</span>${CHEVRON}</span></button>`;
    return `${onRow}\n${snoozeRow}\n${weekendRow}`;
  }

  function html(d, { flash, device }) {
    const { row, tile, CHEVRON, deviceRow } = HubUI;
    const banner = d.snoozed ? `<div class="banner" role="status">${tile('snooze', '#a855f7')}<span class="text"><span class="title">${esc(d.snoozed.title)}</span><span class="sub wrap">${esc(d.snoozed.sub)}</span></span>`
      + `<button class="btn quiet" type="button" data-snooze-open aria-haspopup="dialog">Extend</button><form method="post" action="${ACTION}"><button class="btn quiet" name="snooze" value="off">End</button></form></div>` : '';
    return `${HubUI.flash(flash)}${banner}
<h2 class="label"${d.snoozed ? '' : ' style="margin-top:4px"'}>Notifications</h2>
<div class="group">
${deviceRow(device.state(d.device))}
${notificationRows(d)}
${d.presence ? row({ icon: tile('laptop', 'var(--color-quiet)'), title: esc(d.presence.title), sub: esc(d.presence.sub), wrap: true }) : ''}
</div>
<p class="note">Pushes come only when something needs you. Questions go at once unless held overnight, snoozed or for the weekend; then they wait and go when the hold ends. Urgent pushes go through those holds. Needs you, the badge and the daily wakes carry on either way.</p>
<h2 class="label">Polling</h2>
<div class="group">${row({ icon: tile('clock', '#3b82f6'), title: 'Polling', sub: esc(d.polling), wrap: true, trail: CHEVRON, href: '/_hub/settings/polling' })}</div>
<p class="note">Polling sets the windows, the overnight hold and the daily wakes.</p>
<h2 class="label" id="codex">Codex</h2>
<div class="group"><div class="block">
<form class="segments" method="post" action="/_hub/settings/codex" role="group" aria-labelledby="codex" aria-describedby="codexDescription codexNote">
${d.codex.choices.map((c) => `<button type="submit" name="value" value="${esc(c.value)}" aria-pressed="${c.on}">${esc(c.label)}</button>`).join('')}
</form>
<p class="note" id="codexDescription" role="status">${esc(d.codex.description)}</p>
</div></div>
<p class="note" id="codexNote">${esc(d.codex.note)}</p>`;
  }

  (globalThis.AppViews ||= {})['hub-settings'] = {
    className: 'hub-view view-hub-settings',
    title: () => 'Hub Settings',
    markup: () => `${BoardUI.header({ lead: 'back', backHref: '/_hub/', backLabel: 'Back to the hub', title: 'Settings', time: 'now', logoSrc: '/_hub/kickflip.png', settingsHref: '/_hub/settings' })}
<main class="has-top"><div class="hs-top"></div>
<h2 class="label" id="rules">Rules for every board</h2>
<div id="hubRules"></div>
<p class="note">Standing instructions every board's Claude session sees each time it wakes. Saving tells each one, and it says what changes. A board's own rules are in that board's Settings.</p>
<div class="hs-sheet"></div></main>`,

    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const top = B.$('.hs-top');
      const sheetBox = B.$('.hs-sheet');
      const rulesBox = B.$('#hubRules');
      let flash = null;
      let rules = null;
      let rulesJSON = '';
      let scrolled = !ctx.view?.hash;
      const open = () => B.$('#snoozeSheet');

      function paint() {
        if (!last) return;
        top.innerHTML = html(last, { flash, device }) + `<h2 class="label">Closed boards</h2><div class="group">${(last.closed || []).length ? last.closed.map((b) => `<div class="row"><span class="body"><span class="text"><span class="title">${esc(b.title)}</span><span class="sub wrap">Folder kept on this Mac · /${esc(b.route)}</span></span><button class="btn" type="button" data-reopen="${esc(b.route)}"${reopening ? ' disabled' : ''}>${reopening === b.route ? 'Reopening…' : 'Reopen'}</button></span></div>`).join('') : '<p class="note">No closed boards.</p>'}</div>`;
        if (!open()?.open) sheetBox.innerHTML = last.sheet ? sheet(last.sheet) : '';
        const json = JSON.stringify(last.rules);
        if (!rules) {
          rules = RulesEditor.mount(rulesBox, {
            rules: last.rules, buttons: { primary: 'btn', quiet: 'btn quiet', icon: 'btn quiet' },
            empty: 'No rules for every board yet.', placeholder: 'Add a rule, such as: Screenshots in every PR that changes a page',
            async save(body) {
              const r = await fetch('/_hub/settings/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              const out = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(out.error || 'Could not save. Is the Mac awake?');
              const n = out.events.length;
              rulesJSON = JSON.stringify(out.rules);
              return { rules: out.rules, message: !out.changed ? 'Nothing changed.' : `Saved. Sent to ${n} board${n === 1 ? '' : 's'}${out.failed.length ? `; ${out.failed.length} could not take it.` : '.'}` };
            },
          });
          rulesJSON = json;
        } else if (json !== rulesJSON && !rulesBox.hasAttribute('data-dirty')) {
          rules.set(last.rules);
          rulesJSON = json;
        }
        if (!scrolled && deviceShown) { scrolled = true; root.querySelector(ctx.view.hash)?.scrollIntoView(); }
      }

      // The device row shows a moment after the data and pushes the rules down, so the hash scroll waits for it.
      let deviceShown = false;
      let reopening = null;
      const device = HubKit.device(B, { paint, changed: () => ctx.sidebarChanged?.() });
      device.ready.then(() => { deviceShown = true; if (B.alive()) paint(); });
      B.on(root, 'click', (e) => {
        if (e.target.closest?.('[data-snooze-open]')) open()?.showModal();
        else if (e.target === open()) open().close();
      });
      B.on(root, 'click', async (e) => {
        const button = e.target.closest?.('[data-reopen]');
        if (!button || reopening) return;
        reopening = button.dataset.reopen;
        flash = null;
        paint();
        try {
          const r = await fetch('/_hub/reopen-board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: reopening }) });
          const out = await r.json();
          if (!r.ok) throw new Error(out.error || 'Could not reopen board.');
          last.closed = (last.closed || []).filter((b) => b.route !== out.route);
          ctx.sidebarChanged?.();
          flash = { text: 'Board reopened. Its recorded session is resuming.' };
        } catch (error) { flash = { text: error.message || 'Could not reopen board. Is the Mac awake?', error: true }; }
        reopening = null;
        if (B.alive()) paint();
      });
      B.on(root, 'change', async (e) => {
        const on = e.target;
        if (on.id !== 'notifyOn') return;
        if (on.checked || await BoardDialogs.confirm(on.dataset.confirm)) on.form.requestSubmit();
        else on.checked = true;
      });
      const forms = HubKit.forms(B, {
        answer(out) {
          last = out;
          flash = null;
          if (open()?.open) open().close();
          paint();
          ctx.sidebarChanged?.();
        },
        fail(message) {
          flash = { text: message, error: true };
          if (open()?.open) open().close();
          paint();
        },
      });
      HubKit.live(B, {
        url: () => '/_hub/api/settings',
        paint(d) {
          if (!d) { if (!last) top.innerHTML = '<p class="note">Offline. Is the Mac awake?</p>'; return; }
          last = d;
          paint();
        },
        busy: () => Boolean(reopening) || device.busy() || forms.busy() || Boolean(root.querySelector('dialog[open], [data-dirty], input:focus, textarea:focus')),
      });
      paint();
    }),
  };
})();
