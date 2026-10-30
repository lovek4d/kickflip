// Board Settings, /<route>/settings.html, a view of the app shell (shell.js): auto-merge, reviewers and rules.
// Saving reviewers sends a `reviewers` event {add: [name], remove: [name]}; Claude finds each new person's Slack and
// GitHub accounts, writes the list with board.mjs reviewers, and replies. The rules editor marks [data-dirty] while
// an edit is unsaved, and the shell asks before leaving then.
(globalThis.AppViews ||= {}).settings = {
  className: 'view-settings',
  title: () => 'Board Settings',
  markup: () => `${BoardUI.header({ lead: 'back', title: 'Settings' })}
<main class="set">
  <p class="muted small">Notifications and polling live in <a href="/_hub/settings">hub Settings</a>.</p>
  <h2>Merging</h2>
  <label class="who" for="autoMerge">
    <span><span>Auto-merge approved PRs</span>
      <span class="muted small sub">On: Claude merges a PR once it is approved, CI is green and it merges cleanly. Off: its card shows you a Merge button.</span></span>
    <input type="checkbox" class="toggle" id="autoMerge" disabled>
  </label>
  <p class="muted small" id="autoMergeStatus"></p>
  <h2>Reviewers</h2>
  <p class="muted small">Everyone here gets each PR link on this board once it's ready, and the weekday digest. Someone you add also gets the links of PRs already in review.</p>
  <div id="list"><p class="muted small">Loading…</p></div>
  <form class="add" id="addForm">
    <input id="addName" placeholder="Add someone by name" autocomplete="off">
    <button type="submit">Add</button>
  </form>
  <div class="row" style="margin-top:12px"><span class="muted small" id="saveStatus"></span><button class="primary" id="save" disabled>Save</button></div>
  <div class="replies" id="replies"></div>
  <h2>Rules</h2>
  <p class="muted small">Standing instructions for this board's Claude session. It sees them each time it wakes, and says what changes when you save.</p>
  <div id="rules"><p class="muted small">Loading…</p></div>
  <div class="replies" id="rulesReplies"></div>
  <h3 class="muted small" style="margin:14px 0 0;font-weight:600">For every board</h3>
  <div id="hubRules"><p class="muted small">Loading…</p></div>
  <p class="muted small">Edit these in <a href="/_hub/settings#rules">hub Settings</a>.</p>
</main>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
    const { $, site } = B;
    const { esc, fetchJSON, restartNotice } = BoardUI;
    const get = (url, onWait) => fetchJSON(url, { onWait, sleep: B.sleep });
    const waitIn = (sel) => () => { $(sel).innerHTML = restartNotice(); };
    let current = [];
    const add = new Set();
    const remove = new Set();
    function render() {
      const rows = [...current.map((n) => ({ n, cls: remove.has(n) ? 'gone' : '' })), ...[...add].map((n) => ({ n, cls: 'new' }))];
      $('#list').innerHTML = rows.length ? rows.map(({ n, cls }) => `<div class="who ${cls}"><span>${esc(n)}${cls === 'new' ? ' <span class="muted small">new</span>' : ''}</span>
        <button class="ghost" data-name="${esc(n)}" aria-label="${cls === 'gone' ? 'Keep' : 'Remove'} ${esc(n)}">${cls === 'gone' ? 'Undo' : '✕'}</button></div>`).join('') : '<p class="muted small">No reviewers yet.</p>';
      $('#save').disabled = !add.size && !remove.size;
    }

    // Refresh shows the view anew, through the shell, which asks first while an edit is unsaved.
    const refresh = $('#refresh');
    B.on(refresh, 'click', () => ctx.reload());
    const loaded = get(site.url('api/board'), waitIn('#list')).then(({ body: d }) => {
      current = d.reviewers || [];
      render();
      $('#status').innerHTML = BoardUI.statusLine(new Date().toISOString(), { watcher: d.checks?.watcher });
    }).catch(() => {
      $('#list').innerHTML = '<p class="muted">Offline. Is the Mac awake?</p>';
      $('#status').innerHTML = BoardUI.statusLine(undefined, { link: 'offline' });
    });
    loaded.then(() => {
      refresh.disabled = false;
      refresh.classList.remove('spinning');
      const gear = $('#settingsLink');
      gear.removeAttribute('aria-disabled');
      gear.removeAttribute('tabindex');
    });

    B.on($('#list'), 'click', (ev) => {
      const b = ev.target.closest('button[data-name]');
      if (!b) return;
      const n = b.dataset.name;
      if (add.has(n)) add.delete(n);
      else if (remove.has(n)) remove.delete(n);
      else remove.add(n);
      render();
    });
    B.on($('#addForm'), 'submit', (ev) => {
      ev.preventDefault();
      const input = $('#addName');
      const n = input.value.trim();
      if (n && !current.some((c) => c.toLowerCase() === n.toLowerCase())) add.add(n);
      input.value = '';
      render();
    });
    B.on($('#save'), 'click', async () => {
      const status = $('#saveStatus');
      try {
        await site.send('reviewers', { add: [...add], remove: [...remove] });
        add.clear(); remove.clear(); render();
        status.textContent = 'Sent. Claude updates the list and replies below.';
      } catch { status.textContent = 'Could not send. Is the Mac awake?'; }
    });
    B.watch((events) => {
      $('#replies').innerHTML = events.map((e) => `<div class="reply">${e.reply ? (e.reply.html ?? '') : '<span class="muted small">Waiting for Claude…</span>'}</div>`).join('');
    }, { kind: 'reviewers' });

    // The toggle saves at once through POST api/settings, which writes board.json itself, so it takes effect with no
    // session awake (docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md).
    const autoMerge = $('#autoMerge');
    const autoMergeStatus = $('#autoMergeStatus');
    get(site.url('api/settings'), waitIn('#autoMergeStatus')).then(({ body: d }) => {
      autoMergeStatus.textContent = '';
      autoMerge.checked = d.settings?.auto_merge === true;
      autoMerge.disabled = false;
    }).catch(() => { autoMergeStatus.textContent = 'Offline. Is the Mac awake?'; });
    B.on(autoMerge, 'change', async () => {
      const want = autoMerge.checked;
      if (want && !(await BoardDialogs.confirm('Turn on auto-merge? Claude merges each approved PR on this board once CI is green and it merges cleanly, without asking you.'))) {
        autoMerge.checked = false;
        return;
      }
      autoMerge.disabled = true;
      try {
        const r = await fetch(site.url('api/settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: want }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error);
        autoMerge.checked = out.settings.auto_merge === true;
        autoMergeStatus.textContent = autoMerge.checked ? 'Saved. Claude merges approved, green PRs itself.' : 'Saved. Approved, green PRs wait for your Merge.';
      } catch (e) {
        autoMerge.checked = !want;
        autoMergeStatus.textContent = e.message || 'Could not save. Is the Mac awake?';
      }
      autoMerge.disabled = false;
    });

    // Saving writes board.json through POST api/rules, whose `rules {scope: "board"}` event wakes Claude to acknowledge
    // the change; replies show below, newest first. The hub's rules show read-only.
    get(site.url('api/rules'), waitIn('#rules')).then(({ body: d }) => {
      if (!B.alive()) return;
      RulesEditor.mount($('#rules'), {
        rules: d.board, buttons: { primary: 'primary', quiet: '', icon: 'ghost' }, empty: 'No rules for this board yet.',
        placeholder: 'Add a rule, such as: Ask before touching main',
        async save(body) {
          const r = await fetch(site.url('api/rules'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const out = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(out.error || 'Could not save. Is the Mac awake?');
          return { rules: out.rules, message: out.id ? 'Saved. Claude acknowledges it below.' : 'Nothing changed.' };
        },
      });
      RulesEditor.mount($('#hubRules'), { rules: d.hub, readOnly: true, empty: 'None.' });
    }).catch(() => { for (const sel of ['#rules', '#hubRules']) $(sel).innerHTML = '<p class="muted">Offline. Is the Mac awake?</p>'; });
    B.watch((events) => {
      $('#rulesReplies').innerHTML = (events || []).slice(0, 3).map((e) => `<div class="reply">${e.reply ? (e.reply.html ?? '') : '<span class="muted small">Waiting for Claude…</span>'}</div>`).join('');
    }, { kind: 'rules' });
  }),
};
