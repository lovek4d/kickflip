// HubSettings: the hub settings view-hub.js mounts below the Hub page's health and status, as collapsed rows that
// expand in place (docs/adr/0074-hub-settings-expand-in-place-and-board-settings-open-in-a-modal.md), in hub/views.mjs
// settingsView's words from GET /_hub/api/settings. Each toggle and snooze posts to /_hub/settings/notifications and saves
// at once. The rules editor saves through POST /_hub/settings/rules and marks [data-dirty] while an edit is unsaved, so
// the shell asks before leaving then. The data refreshes every 30 seconds while nothing is being edited.
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

  const sections = [['notifications', 'Notifications'], ['polling', 'Polling'], ['codex', 'Codex share'], ['rules', 'Rules for every board'], ['closed', 'Closed boards']];
  const markup = () => `<div class="hs-flash"></div>${sections.map(([id, title]) => `<details class="hub-setting" id="${id}"><summary><span class="text"><span class="title">${title}</span><span class="sub" data-summary="${id}">Loading…</span></span><span class="chev" aria-hidden="true">›</span></summary><div class="setting-content" data-content="${id}">${id === 'rules' ? '<div id="hubRules"></div><p class="note">Standing instructions every board’s session sees each time it wakes. A board’s own rules are in its Settings.</p>' : ''}</div></details>`).join('')}<div class="hs-sheet"></div>`;

  globalThis.HubSettings = {
    markup,
    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const top = B.$('.hs-flash');
      const sheetBox = B.$('.hs-sheet');
      const rulesBox = B.$('#hubRules');
      let flash = null;
      let rules = null;
      let rulesJSON = '';
      let requestedHash = ctx.view?.hash;
      let scrolled = !requestedHash;
      const open = () => B.$('#snoozeSheet');

      function paint() {
        if (!last) return;
        const { row, tile, CHEVRON, deviceRow } = HubUI;
        top.innerHTML = HubUI.flash(flash);
        B.$('[data-content="notifications"]').innerHTML = `${last.snoozed ? `<div class="banner" role="status"><span>${esc(last.snoozed.title)} · ${esc(last.snoozed.sub)}</span><button class="btn quiet" type="button" data-snooze-open>Extend</button><form method="post" action="${ACTION}"><button class="btn quiet" name="snooze" value="off">End</button></form></div>` : ''}<div class="group">${deviceRow(device.state(last.device))}${notificationRows(last)}${last.presence ? row({ icon: tile('laptop', 'var(--color-quiet)'), title: esc(last.presence.title), sub: esc(last.presence.sub), wrap: true }) : ''}</div>`;
        B.$('[data-content="polling"]').innerHTML = `<div class="group">${row({ icon: tile('clock', '#3b82f6'), title: 'Windows, overnight hold, daily wakes', sub: esc(last.polling), wrap: true, trail: CHEVRON, href: '/_hub/settings/polling' })}</div>`;
        B.$('[data-content="codex"]').innerHTML = `<div class="group"><div class="block"><form class="segments" method="post" action="/_hub/settings/codex" role="group" aria-labelledby="codexLabel" aria-describedby="codexDescription codexNote">${last.codex.choices.map((c) => `<button type="submit" name="value" value="${esc(c.value)}" aria-pressed="${c.on}">${esc(c.label)}</button>`).join('')}</form><p class="note" id="codexDescription" role="status">${esc(last.codex.description)}</p></div></div><p class="note" id="codexNote">${esc(last.codex.note)}</p>`;
        B.$('#codex summary .title').setAttribute('id', 'codexLabel');
        B.$('[data-content="closed"]').innerHTML = `<div class="group">${(last.closed || []).length ? last.closed.map((b) => `<div class="row"><span class="body"><span class="text"><span class="title">${esc(b.title)}</span><span class="sub wrap">Folder kept on this Mac · /${esc(b.route)}</span></span><button class="btn" type="button" data-reopen="${esc(b.route)}"${reopening ? ' disabled' : ''}>${reopening === b.route ? 'Reopening…' : 'Reopen'}</button></span></div>`).join('') : '<p class="note">No closed boards.</p>'}</div>`;
        const summaries = {
          notifications: [last.on.on ? 'Pushes on' : 'Pushes off', last.snoozed?.title, last.weekends.on ? 'Off on weekends' : '', deviceSummary()].filter(Boolean).join(' · '),
          polling: last.polling,
          codex: last.codex.choices.find((c) => c.on)?.label || 'Off',
          rules: last.rules.length ? `${last.rules.length} rule${last.rules.length === 1 ? '' : 's'}` : 'None yet',
          closed: last.closed?.length ? `${last.closed.length} closed` : 'No closed boards',
        };
        for (const [id] of sections) B.$(`[data-summary="${id}"]`).textContent = summaries[id];
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
              last.rules = out.rules;
              B.$('[data-summary="rules"]').textContent = out.rules.length ? `${out.rules.length} rule${out.rules.length === 1 ? '' : 's'}` : 'None yet';
              rulesJSON = JSON.stringify(out.rules);
              return { rules: out.rules, message: !out.changed ? 'Nothing changed.' : `Saved. Sent to ${n} board${n === 1 ? '' : 's'}${out.failed.length ? `; ${out.failed.length} could not take it.` : '.'}` };
            },
          });
          rulesJSON = json;
        } else if (json !== rulesJSON && !rulesBox.hasAttribute('data-dirty')) {
          rules.set(last.rules);
          rulesJSON = json;
        }
        if (!scrolled && deviceShown) reveal(requestedHash);
      }

      // hub-kit.js device() titles its row 'This device' only where this device can take pushes.
      function deviceSummary() {
        const d = device.state('');
        if (!d) return '';
        if (d.title !== 'This device') return d.title;
        return d.sub?.startsWith('On') ? 'This device on' : 'This device off';
      }

      function reveal(hash) {
        const id = { push: 'notifications', 'closed-boards': 'closed' }[hash?.slice(1)] || hash?.slice(1);
        if (!sections.some(([section]) => section === id)) { scrolled = true; return; }
        const section = B.$(`#${id}`);
        section.open = true;
        section.scrollIntoView?.({ block: 'start' });
        scrolled = true;
      }
      B.revealSettings = () => reveal(requestedHash);
      B.on(window, 'hashchange', () => {
        requestedHash = AppRouter.viewOf(location.href)?.hash || location.hash;
        reveal(requestedHash);
      });
      let deviceShown = false;
      let reopening = null;
      let unfit = null;
      B.atUnmount(() => { unfit?.(); open()?.close(); });
      const device = HubKit.device(B, { paint, changed: () => ctx.sidebarChanged?.() });
      device.ready.then(() => { deviceShown = true; if (B.alive()) paint(); });
      B.on(root, 'close', (e) => { if (e.target.id === 'snoozeSheet') { unfit?.(); unfit = null; } }, true);
      B.on(root, 'click', (e) => {
        if (e.target.closest?.('[data-snooze-open]')) {
          if (open()) { unfit?.(); unfit = BoardDialogs.fitSheet(open()); open().showModal(); }
        }
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
        accepts: (action) => action !== '/_hub/push/flush',
        answer(out) {
          last = out;
          flash = null;
          if (open()?.open) open().close();
          unfit?.(); unfit = null;
          paint();
          ctx.sidebarChanged?.();
        },
        fail(message) {
          flash = { text: message, error: true };
          if (open()?.open) open().close();
          unfit?.(); unfit = null;
          paint();
        },
      });
      B.refreshSettings = HubKit.live(B, {
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
