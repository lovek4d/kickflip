// HubSettings: summary rows below Hub’s health and status open centred settings modals ([hub settings open as modals](docs/adr/2026-11-01-1221-hub-settings-open-as-modals.md)), using
// settingsView's words from GET /_hub/api/settings. Pause hub, first, posts to /_hub/settings/hub-pause. Each toggle and snooze posts to /_hub/settings/notifications, Quiet
// hours' times and hold to /_hub/settings/quiet, and Keep awake to /_hub/settings/keep-awake, and saves at once, as Linear's key and Slack's token do through linear-key.js; Done waits for
// a key's save to land. The rules editor saves through POST /_hub/settings/rules
// and marks [data-dirty] while an edit is unsaved, so the shell asks before leaving then. The data refreshes every 30 seconds while nothing is being edited.
(function () {
  // The last data, which a return to the view paints at once.
  let last = null;
  const { esc } = HubUI;
  const ACTION = '/_hub/settings/notifications';

  const { durationPicker } = HubKit;
  // Pause hub (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md), gray as every paused status.
  const pauseRow = (p) => durationPicker({ id: 'pauseHub', title: 'Pause hub', icon: HubUI.tile('pause', 'var(--color-quiet)'),
    action: '/_hub/settings/hub-pause', name: 'pause', choices: p.choices, on: p.on, button: 'Resume' });
  const snoozeRow = (d) => durationPicker({ id: 'snooze', title: 'Snooze', icon: HubUI.tile('snooze', '#a855f7'), action: ACTION, name: 'snooze',
    choices: d.snooze?.choices, on: d.snoozed, button: 'End' });
  // A checkbox row like Push notifications, grey while off and orange while on, as the machine working
  // (docs/adr/2026-11-01-1817-colour-says-whos-waiting.md). Unchecked posts nothing, which the hub reads as off.
  const awakeRow = (a) => `<form class="row field" method="post" action="/_hub/settings/keep-awake">${HubUI.tile('coffee', a.on ? 'var(--color-notice)' : 'var(--color-quiet)')}<label class="body"><span class="text"><span class="title">Keep awake</span></span><input type="checkbox" id="awake" name="keep_awake" value="on" class="toggle" data-submit${a.on ? ' checked' : ''}></label></form>`;

  // The on/off, snooze and weekend rows (docs/adr/2026-10-29-1639-notifications-can-be-off-snoozed-or-off-on-weekends.md).
  function notificationRows(d) {
    const { tile } = HubUI;
    const toggle = ({ icon, set, title, checked, attrs = '' }) => `<form class="row field" method="post" action="${ACTION}"><input type="hidden" name="set" value="${set}">${icon}<label class="body"><span class="text"><span class="title">${title}</span></span><input type="checkbox" name="value" value="on" class="toggle"${attrs}${checked ? ' checked' : ''}></label></form>`;
    const onRow = toggle({ icon: tile('power', d.on.on ? '#22c55e' : '#6b7280'), set: 'on', title: 'Push notifications', checked: d.on.on,
      attrs: ` id="notifyOn" data-confirm="${esc(d.on.confirm)}"` });
    const weekendRow = toggle({ icon: tile('calendar', 'var(--color-quiet)'), set: 'weekends', title: 'Off on weekends', checked: d.weekends.on, attrs: ' data-submit' });
    return `${onRow}\n${snoozeRow(d)}\n${weekendRow}`;
  }

  // Quiet hours (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md): start and
  // end, each saved once its picker closes, the overnight hold, the muted cadence hint and what the snoozes and wake read.
  function quietRows(q) {
    const { row, tile } = HubUI;
    const time = (name, title, value) => `<form class="row field" method="post" action="/_hub/settings/quiet"><label class="body"><span class="text title">${title}</span><input type="time" name="${name}" value="${esc(value)}" required data-autosave></label></form>`;
    const holdRow = `<form class="row field" method="post" action="/_hub/settings/quiet"><input type="hidden" name="set" value="hold">${tile('moon', 'var(--accent)')}<label class="body"><span class="text"><span class="title">Hold pushes</span><span class="sub wrap">${esc(q.hold.sub)}</span></span><input type="checkbox" name="value" value="on" class="toggle" data-submit${q.hold.on ? ' checked' : ''}></label></form>`;
    const reads = q.reads.map((r) => row({ title: esc(r.title), sub: `<span class="sub wrap">${esc(r.sub)}</span>` })).join('');
    return `<div class="group">${time('start', 'Starts', q.start)}${time('end', 'Ends', q.end)}${holdRow}</div><p class="quiet-hint">${esc(q.hint)}</p>`
      + `<h2 class="label">Snoozes and wakes read</h2><div class="group">${reads}</div>`;
  }

  const sections = [['pause', 'Pause hub'], ['notifications', 'Notifications'], ['quiet', 'Quiet hours'], ['keep-awake', 'Keep awake'], ['linear', 'Linear'], ['slack', 'Slack'], ['rules', 'Rules for every board'], ['closed', 'Closed boards']];
  const sectionOf = (hash) => {
    const id = { push: 'notifications', 'closed-boards': 'closed', polling: 'quiet' }[hash?.slice(1)] || hash?.slice(1);
    return sections.some(([section]) => section === id) ? id : null;
  };
  const markup = () => `${sections.map(([id, title]) => `<button type="button" class="hub-setting" id="${id}" data-settings-open="${id}" aria-haspopup="dialog"><span class="text"><span class="title">${title}</span><span class="sub" data-summary="${id}">Loading…</span></span><span class="chev" aria-hidden="true">›</span></button>`).join('')}
<dialog class="settings-modal hub-modal" id="hubSettingsModal" aria-labelledby="hubSettingsTitle"><div class="settings-head"><div><h2 id="hubSettingsTitle" tabindex="-1"></h2><p class="muted small">Hub settings</p></div><button type="button" class="ghost" data-settings-dismiss aria-label="Close hub settings">✕</button></div><div class="set settings-body"><div class="hs-flash"></div><div class="setting-content"></div></div><div class="settings-footer"><button type="button" data-settings-dismiss>Done</button></div></dialog>`;

  globalThis.HubSettings = {
    markup,
    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const top = B.$('.hs-flash');
      const modal = B.$('#hubSettingsModal');
      const content = B.$('.setting-content');
      let active = null;
      let settingsURL = '/_hub/';
      let returnFocus = null;
      let unfitModal = null;
      let flash = null;
      let rules = null;
      let rulesJSON = '';
      let tokenSlot = null;
      const pickers = HubKit.durationPickers(B);

      function paint() {
        if (!last) return;
        const { row, tile, deviceRow } = HubUI;
        top.innerHTML = HubUI.flash(flash);
        const scrollTop = B.$('.settings-body').scrollTop;
        if (active === 'pause') {
          content.innerHTML = `<div class="group">${pauseRow(last.pause)}</div><p class="note">Running steps finish. No new builders, planners or pulls start on any board until then, as when usage reaches the pause line.</p>`;
        } else if (active === 'notifications') {
          content.innerHTML = `<div class="group">${deviceRow(device.state(last.device), { compact: true })}${notificationRows(last)}</div>`;
        } else if (active === 'quiet') {
          content.innerHTML = quietRows(last.quiet);
        } else if (active === 'keep-awake') {
          content.innerHTML = last.awake.unsupported ? `<p class="note">${esc(last.awake.unsupported)}.</p>`
            : `<div class="group">${awakeRow(last.awake)}</div><p class="note">Runs <code>caffeinate -s</code> on the host so it doesn’t sleep while boards work, only while it is on AC power. On battery it holds nothing. The screen can still turn off.</p>`;
        } else if (active === 'linear' || active === 'slack') {
          if (tokenSlot) tokenSlot.set(last[active]);
          else {
            tokenSlot = LinearKey.mount(content, { kind: active, state: last[active],
              saved(out) { last = out; flash = null; paint(); ctx.sidebarChanged?.(); },
              busy: (on) => LinearKey.doneBusy(modal.querySelectorAll('[data-settings-dismiss]'), on) });
          }
        } else if (active === 'closed') {
          content.innerHTML = `<div class="group">${(last.closed || []).length ? last.closed.map((b) => `<div class="row"><span class="body"><span class="text"><span class="title">${esc(b.title)}</span><span class="sub wrap">/${esc(b.route)}</span></span><button class="btn" type="button" data-reopen="${esc(b.route)}"${reopening === b.route ? BoardUI.BUSY : reopening ? ' disabled' : ''}>Reopen</button></span></div>`).join('') : '<p class="note">No closed boards.</p>'}</div>`;
        }
        pickers.painted();
        B.$('.settings-body').scrollTop = scrollTop;
        B.$('#keep-awake').disabled = Boolean(last.awake.unsupported);
        const summaries = {
          pause: last.pause.summary,
          notifications: [last.on.on ? 'Pushes on' : 'Pushes off', last.snoozed?.summary, last.weekends.on ? 'Off on weekends' : '', deviceSummary()].filter(Boolean).join(' · '),
          quiet: last.quiet.summary,
          'keep-awake': last.awake.summary,
          linear: last.linear?.summary || 'No key',
          slack: last.slack?.summary || 'No token',
          rules: last.rules.length ? `${last.rules.length} rule${last.rules.length === 1 ? '' : 's'}` : 'None yet',
          closed: last.closed?.length ? `${last.closed.length} closed` : 'No closed boards',
        };
        for (const [id] of sections) B.$(`[data-summary="${id}"]`).textContent = summaries[id];
        if (active !== 'rules') return;
        const rulesBox = B.$('#hubRules');
        const json = JSON.stringify(last.rules);
        if (!rules) {
          rules = RulesEditor.mount(rulesBox, {
            rules: last.rules, buttons: { primary: 'btn', quiet: 'btn quiet', icon: 'btn quiet' },
            empty: 'No rules for every board yet.', placeholder: 'Add a rule, such as: Screenshots in every PR that changes a page',
            async save(body) {
              const r = await fetch('/_hub/settings/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              const out = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(out.error || 'Could not save. Is the host awake?');
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
      }

      // hub-kit.js device() titles its row 'This device' only where this device can take pushes.
      function deviceSummary() {
        const d = device.state('');
        if (!d) return '';
        if (d.title !== 'This device') return d.title;
        return d.sub?.startsWith('On') ? 'This device on' : 'This device off';
      }

      function closeModal(restore = true) {
        unfitModal?.(); unfitModal = null;
        modal.close();
        tokenSlot?.destroy(); tokenSlot = null;
        content.innerHTML = '';
        rules = null;
        active = null;
        if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      }
      // Also used by shell.js for legacy links, pushes, back and forward. Replacing the URL keeps Hub's history.
      B.openSettings = async (view, opener) => {
        const id = sectionOf(view?.hash);
        if (active && id !== active && modal.querySelector('[data-dirty]')) {
          if (!(await BoardDialogs.confirm('Leave without saving? Your unsaved edits here will be lost.'))) return false;
          if (!B.alive()) return false;
        }
        if (id !== active) {
          closeModal(!id);
          active = id;
          if (id) {
            returnFocus = opener || B.$(`#${id}`);
            B.$('#hubSettingsTitle').textContent = sections.find(([section]) => section === id)[1];
            content.innerHTML = id === 'rules' ? '<div id="hubRules" class="rules-box"></div>' : '<p class="note">Loading…</p>';
            flash = null;
            paint();
            unfitModal = BoardDialogs.fitSheet(modal);
            ctx.closeSidebar?.();
            modal.showModal();
            B.$('.settings-body').scrollTop = 0;
            B.$('#hubSettingsTitle').focus({ preventScroll: true });
          }
        }
        settingsURL = AppRouter.urlOf({ kind: 'hub', ...(id ? { hash: `#${id}` } : {}) });
        history.replaceState(history.state, '', settingsURL);
        return true;
      };
      const dismiss = () => {
        if (!tokenSlot?.busy()) { B.openSettings({ kind: 'hub' }); return; }
        tokenSlot.settled().then(() => { if (B.alive()) B.openSettings({ kind: 'hub' }); });
      };
      B.on(modal, 'cancel', (e) => { e.preventDefault(); dismiss(); });
      B.on(root, 'click', (e) => {
        const opener = e.target.closest?.('[data-settings-open]');
        if (opener) { B.openSettings({ hash: `#${opener.dataset.settingsOpen}` }, opener); return; }
        if (e.target.closest?.('[data-settings-dismiss]')) { dismiss(); return; }
        if (BoardUI.onBackdrop(e, modal)) {
          const r = modal.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dismiss();
        }
      });
      B.on(window, 'hashchange', async () => {
        if (!(await B.openSettings(AppRouter.viewOf(location.href))) && B.alive()) history.replaceState(history.state, '', settingsURL);
      });
      let reopening = null;
      B.atUnmount(() => closeModal(false));
      const device = HubKit.device(B, { paint, changed: () => ctx.sidebarChanged?.() });
      device.ready.then(() => { if (B.alive()) paint(); });
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
        } catch (error) { flash = { text: error.message || 'Could not reopen board. Is the host awake?', error: true }; }
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
          paint();
          ctx.sidebarChanged?.();
        },
        fail(message) {
          flash = { text: message, error: true };
          paint();
        },
      });
      B.refreshSettings = HubKit.live(B, {
        url: () => '/_hub/api/settings',
        paint(d) {
          if (!d) { if (!last) top.innerHTML = '<p class="note">Offline. Is the host awake?</p>'; return; }
          last = d;
          paint();
        },
        busy: () => Boolean(reopening) || device.busy() || forms.busy() || Boolean(root.querySelector('dialog[open], [data-dirty], input:focus, textarea:focus')),
      });
      paint();
      B.openSettings(ctx.view);
    }),
  };
})();
