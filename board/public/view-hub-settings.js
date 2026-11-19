// HubSettings: summary rows open centred settings modals ([hub settings open as modals](docs/adr/2026-11-01-1221-hub-settings-open-as-modals.md)), using
// settingsView's words from GET /_hub/api/settings. Linear's key and Slack's token open the same modal from the button on their Integrations rows (view-hub.js),
// with no summary row of their own ([Linear and Slack keys open in modals from their Integrations rows](docs/adr/2026-11-09-2230-linear-and-slack-keys-open-in-modals-from-their-integrations-rows.md)); Slack's
// holds its PR state reactions and signature (slack-emoji.js) under the token. Pause hub, first, posts to /_hub/settings/hub-pause. Each toggle and snooze posts to /_hub/settings/notifications, except
// the Alerts sheet's, which Notifications' Alerts row opens stacked on the modal: its toggles post to /_hub/settings/alerts. Quiet
// hours' times and hold to /_hub/settings/quiet, its Overnight work toggles to /_hub/settings/overnight, and saves at once, as Linear's key and Slack's token do through linear-key.js; Done waits for
// a key's save to land. The rules editor saves through POST /_hub/settings/rules
// and marks [data-dirty] while an edit is unsaved, so the shell asks before leaving then. The data refreshes every 30 seconds while nothing is being edited.
// A Closed boards row opens that board's detail sheet, stacked on the modal, whose Reopen and Delete each confirm, then
// post to /_hub/reopen-board or /_hub/delete-board while the row reads reopening… or deleting…; a refusal shows under
// the row with Retry (docs/adr/2026-11-18-2300-a-closed-board-can-be-deleted.md).
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
  // The on/off, snooze and weekend rows (docs/adr/2026-10-29-1639-notifications-can-be-off-snoozed-or-off-on-weekends.md).
  function notificationRows(d) {
    const { tile } = HubUI;
    const toggle = ({ icon, set, title, checked, attrs = '' }) => `<form class="row field" method="post" action="${ACTION}"><input type="hidden" name="set" value="${set}">${icon}<label class="body"><span class="text"><span class="title">${title}</span></span><input type="checkbox" name="value" value="on" class="toggle"${attrs}${checked ? ' checked' : ''}></label></form>`;
    const onRow = toggle({ icon: tile('power', d.on.on ? '#22c55e' : '#6b7280'), set: 'on', title: 'Push notifications', checked: d.on.on,
      attrs: ` id="notifyOn" data-confirm="${esc(d.on.confirm)}"` });
    const weekendRow = toggle({ icon: tile('calendar', 'var(--color-quiet)'), set: 'weekends', title: 'Off on weekends', checked: d.weekends.on, attrs: ' data-submit' });
    const alertsRow = `<button type="button" class="row" data-alerts-open aria-haspopup="dialog">${tile('bell', 'var(--accent)')}<span class="body"><span class="text"><span class="title">Alerts</span><span class="sub">${esc(d.alerts.summary)}</span></span><span class="chev" aria-hidden="true">›</span></span></button>`;
    return `${onRow}\n${snoozeRow(d)}\n${weekendRow}\n${alertsRow}`;
  }

  // docs/adr/2026-11-17-1505-alerts-opt-in-to-sounding-the-live-row-as-implement-or-a-merge-joins.md
  // The Alerts sheet: what an alert does, then a toggle per kind posting kind=<kind> to /_hub/settings/alerts.
  function alertsRows(a) {
    const { tile } = HubUI;
    const kind = (k) => `<form class="row field" method="post" action="/_hub/settings/alerts"><input type="hidden" name="kind" value="${esc(k.kind)}">${tile(k.kind === 'merge' ? 'merge' : 'power', 'var(--accent)')}<label class="body"><span class="text"><span class="title">${esc(k.title)}</span><span class="sub wrap">${esc(k.sub)}</span></span><input type="checkbox" name="value" value="on" class="toggle" data-submit${k.on ? ' checked' : ''}></label></form>`;
    return `<p class="note">${esc(a.note)}</p><div class="group">${a.kinds.map(kind).join('')}</div>`;
  }

  // Quiet hours (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md): start and
  // end, each saved once its picker closes, the overnight hold, the muted cadence hint and what the snoozes and wake read.
  function quietRows(q) {
    const { row, tile } = HubUI;
    const time = (name, title, value) => `<form class="row field" method="post" action="/_hub/settings/quiet"><label class="body"><span class="text title">${title}</span><input type="time" name="${name}" value="${esc(value)}" required data-autosave></label></form>`;
    const holdRow = `<form class="row field" method="post" action="/_hub/settings/quiet"><input type="hidden" name="set" value="hold">${tile('moon', 'var(--accent)')}<label class="body"><span class="text"><span class="title">Hold pushes</span><span class="sub wrap">${esc(q.hold.sub)}</span></span><input type="checkbox" name="value" value="on" class="toggle" data-submit${q.hold.on ? ' checked' : ''}></label></form>`;
    const reads = q.reads.map((r) => row({ title: esc(r.title), sub: `<span class="sub wrap">${esc(r.sub)}</span>` })).join('');
    return `<div class="group">${time('start', 'Starts', q.start)}${time('end', 'Ends', q.end)}${holdRow}</div><p class="quiet-hint">${esc(q.hint)}</p>`
      + `<h2 class="label">Overnight work</h2><div class="group">${overnightRows(q.overnight)}</div>`
      + `<h2 class="label">Snoozes and weekends read</h2><div class="group">${reads}</div>`;
  }

  // Overnight work (docs/adr/2026-11-15-0700-quiet-hours-list-the-overnight-work-each-job-on-by-default.md): when it
  // starts, then a row per job with its last run and a toggle posting to /_hub/settings/overnight. An off row greys.
  const RUN_COLOURS = { ok: 'var(--color-success)', failed: 'var(--color-danger)', never: 'var(--color-quiet)', off: 'var(--color-quiet)' };
  function overnightRows(o) {
    const { tile } = HubUI;
    const run = (last) => `<span class="sub wrap run ${last.tone}">${last.href ? `<a href="${esc(last.href)}">${esc(last.text)}</a>` : esc(last.text)}</span>`;
    const job = (j) => `<form class="row field${j.on ? '' : ' off'}" method="post" action="/_hub/settings/overnight"><input type="hidden" name="job" value="${esc(j.id)}">${tile(j.icon, RUN_COLOURS[j.last.tone])}<label class="body"><span class="text"><span class="title">${esc(j.title)}</span><span class="sub wrap">${esc(j.sub)}</span>${run(j.last)}</span><input type="checkbox" name="value" value="on" class="toggle" aria-label="${esc(j.title)}" data-submit${j.on ? ' checked' : ''}></label></form>`;
    return `<div class="row"><span class="body"><span class="text"><span class="sub wrap">${esc(o.starts)}</span></span></span></div>${o.jobs.map(job).join('')}`;
  }

  // A closed board's row: a button opening its detail sheet, reading reopening… or deleting… while that runs, and under it
  // a refused act's reason with Retry.
  function closedRow(b, { pending, failed }) {
    const busy = pending?.route === b.route ? `${pending.act === 'delete' ? 'deleting' : 'reopening'}…` : '';
    const fault = !busy && failed[b.route];
    const open = `<button type="button" class="row" data-closed-open="${esc(b.route)}" aria-haspopup="dialog"${pending ? ' disabled' : ''}><span class="body"><span class="text"><span class="title">${esc(b.title)}</span><span class="sub">${busy || `/${esc(b.route)}`}</span></span><span class="chev" aria-hidden="true">›</span></span></button>`;
    return open + (fault ? HubUI.row({ title: '', sub: `<span class="danger">${esc(fault.error)}</span>`, wrap: true,
      trail: `<button class="btn" type="button" data-closed-retry="${esc(b.route)}"${pending ? ' disabled' : ''}>Retry</button>` }) : '');
  }
  // A closed board's detail sheet: where it lived and when it closed, then Reopen and a red Delete.
  const closedDetail = (b) => `<div class="group">${HubUI.row({ title: 'Route', trail: `<span class="muted">/${esc(b.route)}</span>` })}${b.closedAt ? HubUI.row({ title: 'Closed', trail: `<span class="muted">${esc(BoardUI.cardTime(b.closedAt))}</span>` }) : ''}${b.repo ? HubUI.row({ title: 'Repo', sub: esc(b.repo), wrap: true }) : ''}</div>`
    + `<div class="closed-actions"><button class="btn" type="button" data-closed-reopen="${esc(b.route)}">Reopen</button><button class="btn danger" type="button" data-closed-delete="${esc(b.route)}">Delete</button></div>`;
  const reopenConfirm = (b) => `Reopen ${b.title}? /${b.route} and its port are taken back and its session starts.`;
  const deleteConfirm = (b) => `Delete ${b.title} for good?\n\nGoes: its closed entry, freeing /${b.route} and its port; its site folder with its tasks, threads, notes and visuals; its builders’ worktrees and local branches; and its clone in the hub’s repos folder unless another board uses it.\n\nKept: your own repo folder, anything another board still uses, and GitHub’s issues, PRs and branches.\n\nThis can’t be undone and touches no GitHub data.`;

  const sections = [['pause', 'Pause hub'], ['notifications', 'Notifications'], ['appearance', 'Appearance'], ['quiet', 'Quiet hours'], ['rules', 'Rules for every board'], ['closed', 'Closed boards']];
  // Linear and Slack open from their Integrations rows, so they have modals and no summary rows.
  const keys = [['linear', 'Linear'], ['slack', 'Slack']];
  const sectionOf = (hash) => {
    const id = { push: 'notifications', 'closed-boards': 'closed', polling: 'quiet' }[hash?.slice(1)] || hash?.slice(1);
    return [...sections, ...keys].some(([section]) => section === id) ? id : null;
  };
  // Polls opens the hub's Polls page, /_hub/polls (hub/polls-page.mjs), a page of its own rather than a modal.
  const pollsRow = '<a class="hub-setting" id="polls" href="/_hub/polls"><span class="text"><span class="title">Polls</span><span class="sub">Every job the hub, boards and pages run again and again, fastest first</span></span><span class="chev" aria-hidden="true">›</span></a>';
  const markup = () => `${sections.map(([id, title]) => `<button type="button" class="hub-setting" id="${id}" data-settings-open="${id}" aria-haspopup="dialog"><span class="text"><span class="title">${title}</span><span class="sub" data-summary="${id}">Loading…</span></span><span class="chev" aria-hidden="true">›</span></button>`).join('')}${pollsRow}
<dialog class="settings-modal hub-modal" id="hubSettingsModal" aria-labelledby="hubSettingsTitle"><div class="settings-head"><div><h2 id="hubSettingsTitle" tabindex="-1"></h2><p class="muted small">Hub settings</p></div><button type="button" class="ghost" data-settings-dismiss aria-label="Close hub settings">✕</button></div><div class="set settings-body"><div class="hs-flash"></div><div class="setting-content"></div></div><div class="settings-footer"><button type="button" data-settings-dismiss>Done</button></div>
<dialog class="sheet alerts-sheet" id="alertsSheet" aria-labelledby="alertsTitle"><div class="alerts-body"><div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="alertsTitle">Alerts</h2><button type="button" class="ghost" data-alerts-dismiss aria-label="Close Alerts">✕</button></div><div class="alerts-content"></div></div></dialog>
<dialog class="sheet closed-sheet" id="closedSheet" aria-labelledby="closedTitle"><div class="closed-body"><div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="closedTitle"></h2><button type="button" class="ghost" data-closed-dismiss aria-label="Close">✕</button></div><div class="closed-content"></div></div></dialog></dialog>`;

  globalThis.HubSettings = {
    markup,
    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const top = B.$('.hs-flash');
      const modal = B.$('#hubSettingsModal');
      const content = B.$('.setting-content');
      const alertsSheet = B.$('#alertsSheet');
      const closedSheet = B.$('#closedSheet');
      // The closed board whose detail sheet is open; the act running, {route, act: 'reopen'|'delete'}; and each route's
      // refused act, {act, error}, shown under its row with Retry.
      let shownClosed = null;
      let pending = null;
      const failed = {};
      let active = null;
      let settingsURL = '/_hub/';
      let returnFocus = null;
      let unfitModal = null;
      let flash = null;
      let rules = null;
      let rulesJSON = '';
      let tokenSlot = null;
      let emojiSlot = null;
      const pickers = HubKit.durationPickers(B);

      // The per-device OLED key app.html's head script reads before paint; colors.css reads the data-oled it sets.
      const oled = () => { try { return localStorage.getItem('hub:oled') === '1'; } catch { return false; } };
      function paint() {
        if (!last) return;
        const { row, tile, deviceRow } = HubUI;
        top.innerHTML = HubUI.flash(flash);
        const scrollTop = B.$('.settings-body').scrollTop;
        if (active === 'pause') {
          content.innerHTML = `<div class="group">${pauseRow(last.pause)}</div><p class="note">Running steps finish. No new builders, planners or pulls start on any board until then, as when usage reaches the pause line.</p>`;
        } else if (active === 'notifications') {
          content.innerHTML = `<div class="group">${deviceRow(device.state(last.device), { compact: true })}${notificationRows(last)}</div>`;
        } else if (active === 'appearance') {
          content.innerHTML = `<div class="group"><div class="row field"><label class="body"><span class="text"><span class="title">OLED mode</span><span class="sub wrap">Applies in dark mode. Saved on this device.</span></span><input type="checkbox" id="oledOn" class="toggle"${oled() ? ' checked' : ''}></label></div></div>`;
        } else if (active === 'quiet') {
          content.innerHTML = quietRows(last.quiet);
        } else if (active === 'linear' || active === 'slack') {
          if (tokenSlot) {
            tokenSlot.set(last[active]);
            emojiSlot?.set(LinearKey.works(last.slack));
          } else {
            // Slack's PR state reactions and signature sit under its token while it works (slack-emoji.js).
            if (active === 'slack') content.innerHTML = '<div class="slack-token"></div><div class="slack-emoji"></div>';
            tokenSlot = LinearKey.mount(active === 'slack' ? B.$('.slack-token') : content, { kind: active, state: last[active],
              saved(out) { last = out; flash = null; paint(); ctx.sidebarChanged?.(); },
              busy: (on) => LinearKey.doneBusy(modal.querySelectorAll('[data-settings-dismiss]'), on) });
            if (active === 'slack') emojiSlot = SlackEmoji.mount(B.$('.slack-emoji'), { on: LinearKey.works(last.slack) });
          }
        } else if (active === 'closed') {
          content.innerHTML = `<div class="group">${(last.closed || []).length ? last.closed.map((b) => closedRow(b, { pending, failed })).join('') : '<p class="note">No closed boards.</p>'}</div>`;
        }
        const shown = closedSheet.open && (last.closed || []).find((b) => b.route === shownClosed);
        if (closedSheet.open && !shown) closedSheet.close();
        if (shown) {
          B.$('#closedTitle').textContent = shown.title;
          B.$('.closed-content').innerHTML = closedDetail(shown);
        }
        B.$('.alerts-content').innerHTML = alertsRows(last.alerts);
        pickers.painted();
        B.$('.settings-body').scrollTop = scrollTop;
        const summaries = {
          pause: last.pause.summary,
          notifications: [last.on.on ? 'Pushes on' : 'Pushes off', last.snoozed?.summary, last.weekends.on ? 'Off on weekends' : '', deviceSummary()].filter(Boolean).join(' · '),
          appearance: oled() ? 'OLED mode on' : 'OLED mode off',
          quiet: last.quiet.summary,
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
        if (alertsSheet.open) alertsSheet.close();
        if (closedSheet.open) closedSheet.close();
        unfitModal?.(); unfitModal = null;
        modal.close();
        tokenSlot?.destroy(); tokenSlot = null;
        emojiSlot?.destroy(); emojiSlot = null;
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
            B.$('#hubSettingsTitle').textContent = [...sections, ...keys].find(([section]) => section === id)[1];
            B.$('.settings-head .muted').textContent = keys.some(([key]) => key === id) ? 'Integrations' : 'Hub settings';
            content.innerHTML = id === 'rules' ? '<div id="hubRules" class="rules-box"></div>' : '<p class="note">Loading…</p>';
            flash = null;
            paint();
            unfitModal = BoardDialogs.fitSheet(modal);
            ctx.closeSidebar?.();
            BoardUI.openSheet(modal);
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
        if (e.target.closest?.('[data-alerts-open]')) { BoardUI.openSheet(alertsSheet); return; }
        if (e.target.closest?.('[data-alerts-dismiss]')) { alertsSheet.close(); return; }
        if (e.target.closest?.('[data-settings-dismiss]')) { dismiss(); return; }
        if (BoardUI.onBackdrop(e, modal)) {
          const r = modal.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dismiss();
        }
      });
      B.on(window, 'hashchange', async () => {
        if (!(await B.openSettings(AppRouter.viewOf(location.href))) && B.alive()) history.replaceState(history.state, '', settingsURL);
      });
      B.atUnmount(() => closeModal(false));
      B.atUnmount(BoardUI.swipeToDismiss(modal));
      B.atUnmount(BoardUI.swipeToDismiss(alertsSheet));
      B.atUnmount(BoardUI.swipeToDismiss(closedSheet));
      B.on(alertsSheet, 'click', (e) => { if (BoardUI.onBackdrop(e, alertsSheet)) alertsSheet.close(); });
      B.on(closedSheet, 'click', (e) => { if (BoardUI.onBackdrop(e, closedSheet)) closedSheet.close(); });
      const device = HubKit.device(B, { paint, changed: () => ctx.sidebarChanged?.() });
      device.ready.then(() => { if (B.alive()) paint(); });
      // Reopens or deletes the closed board at route, its row reading reopening… or deleting… until the hub answers.
      async function act(route, kind) {
        pending = { route, act: kind };
        delete failed[route];
        flash = null;
        paint();
        try {
          const r = await fetch(`/_hub/${kind}-board`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route }) });
          const out = await r.json();
          if (!r.ok) throw new Error(out.error || `Could not ${kind} the board.`);
          last.closed = (last.closed || []).filter((b) => b.route !== route);
          ctx.sidebarChanged?.();
          if (kind === 'reopen') flash = { text: 'Board reopened. Its recorded session is resuming.' };
        } catch (error) { failed[route] = { act: kind, error: error.message || `Could not ${kind} the board. Is the host awake?` }; }
        pending = null;
        if (B.alive()) paint();
      }
      B.on(root, 'click', async (e) => {
        if (e.target.closest?.('[data-closed-dismiss]')) { closedSheet.close(); return; }
        const opener = e.target.closest?.('[data-closed-open]');
        if (opener) {
          if (pending) return;
          shownClosed = opener.dataset.closedOpen;
          BoardUI.openSheet(closedSheet);
          paint();
          return;
        }
        const retry = e.target.closest?.('[data-closed-retry]');
        if (retry) { if (!pending && failed[retry.dataset.closedRetry]) act(retry.dataset.closedRetry, failed[retry.dataset.closedRetry].act); return; }
        const button = e.target.closest?.('[data-closed-reopen], [data-closed-delete]');
        if (!button || pending) return;
        const kind = button.dataset.closedDelete ? 'delete' : 'reopen';
        const board = (last.closed || []).find((b) => b.route === (button.dataset.closedDelete || button.dataset.closedReopen));
        if (!board || !(await BoardDialogs.confirm(kind === 'delete' ? deleteConfirm(board) : reopenConfirm(board)))) return;
        if (!B.alive() || pending) return;
        closedSheet.close();
        act(board.route, kind);
      });
      B.on(root, 'change', async (e) => {
        const on = e.target;
        if (on.id === 'oledOn') {
          try { if (on.checked) localStorage.setItem('hub:oled', '1'); else localStorage.removeItem('hub:oled'); } catch {}
          if (on.checked) document.documentElement.dataset.oled = ''; else delete document.documentElement.dataset.oled;
          paint();
          return;
        }
        if (on.id !== 'notifyOn') return;
        if (on.checked || await BoardDialogs.confirm(on.dataset.confirm)) on.form.requestSubmit();
        else on.checked = true;
      });
      const forms = HubKit.forms(B, {
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
        busy: () => Boolean(pending) || device.busy() || forms.busy() || Boolean(root.querySelector('dialog[open], [data-dirty], input:focus, textarea:focus')),
      });
      paint();
      B.openSettings(ctx.view);
    }),
  };
})();
