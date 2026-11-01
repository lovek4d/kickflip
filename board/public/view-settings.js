// Board Settings, a modal the app shell (shell.js) mounts over its board for /<route>/settings.html.
// Saving reviewers sends a `reviewers` event {add: [name], remove: [name]}; Claude finds each new person's Slack and
// GitHub accounts, writes the list with board.mjs reviewers, and replies. An unsaved edit marks [data-dirty], and the
// shell asks before closing the modal then.
(globalThis.AppViews ||= {}).settings = {
  className: 'view-settings',
  title: () => 'Board Settings',
  markup: (view, { siteTitle = '' } = {}) => `<dialog class="settings-modal" id="boardSettingsModal" aria-labelledby="boardSettingsTitle"><div class="settings-head"><div><h2 id="boardSettingsTitle" tabindex="-1">Board settings</h2><p class="muted small">${BoardUI.esc(siteTitle)}</p></div><button type="button" class="ghost" data-settings-dismiss aria-label="Close board settings">✕</button></div>
<div class="set settings-body">
  <h2>Repo</h2>
  <button type="button" class="who repo-row" id="boardRepo" aria-haspopup="dialog" disabled><span id="boardRepoValue">Loading…</span><span class="muted small">Change ›</span></button>
  <p class="muted small" id="boardRepoStatus"></p>
  <h2>Merging</h2>
  <label class="who" for="autoMerge">
    <span><span>Auto-merge approved PRs</span>
      <span class="muted small sub">On: Claude merges a PR once it is approved, CI is green and it merges cleanly. Off: its card shows you a Merge button.</span></span>
    <input type="checkbox" class="toggle" id="autoMerge" disabled>
  </label>
  <p class="muted small" id="autoMergeStatus"></p>
  <h2>Device installs</h2>
  <p class="muted small">The hub runs this script to build a card's install. Use an absolute path to a file you own, writable only by you. Leave it empty to turn install builds off.</p>
  <form class="add" id="installForm">
    <input id="installScript" aria-label="Install script path" placeholder="/absolute/path/to/install.sh" autocomplete="off" disabled>
    <button type="submit" id="installSave" disabled>Save</button>
  </form>
  <p class="muted small" id="installStatus"></p>
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
  <h2>Board</h2>
  <button class="who close-board-row" id="closeBoard" disabled aria-haspopup="dialog"><span>Close board<span class="muted small sub">Stop its session and server. Keep its cards, threads and notes.</span></span><span aria-hidden="true">›</span></button>
  <p class="muted small" id="closeBoardReason" role="status">Loading…</p>
  <dialog class="sheet close-board-sheet" id="closeBoardSheet" aria-labelledby="closeBoardTitle">
    <form id="closeBoardForm">
      <div class="grab" aria-hidden="true"></div>
      <h2 id="closeBoardTitle">Close this board?</h2>
      <p id="closeBoardName"></p>
      <ul><li>Stop the board’s session.</li><li>Stop its server.</li><li>Remove its sidebar row and manifest entry.</li></ul>
      <p>Keep its folder, cards, threads and notes on this Mac. Reopen later from Hub → Closed boards.</p>
      <div class="close-board-warning" id="closeBoardWarning"></div>
      <label for="closeBoardTyped">Type <strong id="closeBoardTypeName"></strong> to confirm.<input id="closeBoardTyped" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <p class="muted small" id="closeBoardError" role="status"></p>
      <div class="row"><button type="button" id="closeBoardCancel">Cancel</button><button class="danger" type="submit" id="closeBoardConfirm" disabled>Close board</button></div>
    </form>
  </dialog>
</div><div class="settings-footer"><button type="button" data-settings-dismiss>Done</button></div></dialog>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
    const { $, site } = B;
    const { esc, fetchJSON, restartNotice } = BoardUI;
    const get = (url, onWait) => fetchJSON(url, { onWait, sleep: B.sleep });
    const waitIn = (sel) => () => { $(sel).innerHTML = restartNotice(); };
    const modal = $('#boardSettingsModal');
    const previous = document.activeElement;
    const unfitModal = BoardDialogs.fitSheet(modal);
    B.on(modal, 'cancel', (e) => { e.preventDefault(); ctx.dismiss?.(); });
    B.on(modal, 'click', (e) => {
      if (e.target.closest?.('[data-settings-dismiss]')) ctx.dismiss?.();
      else if (e.target === modal) {
        const rect = modal.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) ctx.dismiss?.();
      }
    });
    B.atUnmount(() => { unfitModal(); modal.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); });
    modal.showModal();
    $('#boardSettingsTitle').focus({ preventScroll: true });
    const route = B.route;
    const closeRow = $('#closeBoard');
    const closeSheet = $('#closeBoardSheet');
    const typed = $('#closeBoardTyped');
    const closeConfirm = $('#closeBoardConfirm');
    let closing = false;
    let closure = null;
    let unfit = null;
    const loadClosure = async () => {
      const { body: d } = await get(`/_hub/close-board/${encodeURIComponent(route)}`);
      if (!B.alive()) return;
      closure = d;
      closeRow.disabled = d.hub === true;
      $('#closeBoardReason').textContent = d.hub ? 'The hub board cannot be closed while it is flagged as the hub.' : '';
      $('#closeBoardName').textContent = d.title;
      $('#closeBoardTypeName').textContent = d.title;
      const warnings = [...(d.prs || []).map((p) => `<li>PR #${esc(p.pr)} (${esc(p.repo)}) — ${esc(p.wave)}/${esc(p.id)}</li>`),
        ...(d.builders || []).map((b) => `<li>${esc(b.label)} — ${esc(b.key)}</li>`)];
      $('#closeBoardWarning').innerHTML = warnings.length ? `<h3>This board still has active work</h3><ul>${warnings.join('')}</ul><p>Running builder records will be closed with a note. PRs stay open on GitHub; this board stops polling them.</p>` : '';
    };
    loadClosure().catch(() => { if (B.alive()) $('#closeBoardReason').textContent = 'Could not load Close board. Is the Mac awake?'; });
    B.on(closeRow, 'click', async () => {
      if (closing || closeRow.disabled) return;
      closeRow.disabled = true;
      try {
        await loadClosure();
        if (!B.alive() || closure.hub) return;
        typed.value = '';
        closeConfirm.disabled = true;
        $('#closeBoardError').textContent = '';
        unfit?.();
        unfit = BoardDialogs.fitSheet(closeSheet);
        closeSheet.showModal();
        typed.focus();
      } catch { $('#closeBoardReason').textContent = 'Could not load Close board. Is the Mac awake?'; closeRow.disabled = false; }
    });
    B.on(typed, 'input', () => { closeConfirm.disabled = closing || typed.value !== closure?.title; });
    B.on($('#closeBoardCancel'), 'click', () => closeSheet.close());
    B.on(closeSheet, 'close', () => { unfit?.(); unfit = null; });
    B.on(closeSheet, 'click', (e) => { if (e.target === closeSheet && !closing) closeSheet.close(); });
    B.on($('#closeBoardForm'), 'submit', async (e) => {
      e.preventDefault();
      if (closing || closure?.hub || typed.value !== closure?.title) return;
      closing = true;
      closeConfirm.disabled = true;
      try {
        const r = await fetch('/_hub/close-board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route, name: typed.value }) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Could not close board.');
        if (!B.alive()) return;
        closeSheet.close();
        ctx.sidebarChanged?.();
        ctx.open(out.next || '/_hub/');
      } catch (error) {
        if (B.alive()) $('#closeBoardError').textContent = error.message || 'Could not close board. Is the Mac awake?';
      } finally {
        closing = false;
        closeConfirm.disabled = typed.value !== closure?.title;
      }
    });
    B.atUnmount(() => { unfit?.(); closeSheet.close(); });
    const repoURL = `/_hub/board-repo/${encodeURIComponent(B.route)}`;
    let repo = {}, closeRepo = () => {};
    const showRepo = () => { $('#boardRepoValue').textContent = repo.github ? `${repo.github} · ${repo.branch || 'Branch not recorded'}` : 'No GitHub repo'; };
    get(repoURL).then(({ body }) => {
      if (!B.alive()) return;
      repo = body;
      showRepo();
      $('#boardRepo').disabled = false;
    }).catch(() => { $('#boardRepoValue').textContent = 'Could not load repo.'; });
    B.on($('#boardRepo'), 'click', () => {
      closeRepo = BoardDialogs.repoSheet({ current: repo, async save(input) {
        const r = await fetch(repoURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Could not save repo.');
        repo = out;
        if (!B.alive()) return;
        showRepo();
        $('#boardRepoStatus').textContent = 'Saved. The board’s session has been told.';
      } });
    });
    B.atUnmount(() => closeRepo());
    let current = [];
    const add = new Set();
    const remove = new Set();
    function render() {
      const rows = [...current.map((n) => ({ n, cls: remove.has(n) ? 'gone' : '' })), ...[...add].map((n) => ({ n, cls: 'new' }))];
      $('#list').innerHTML = rows.length ? rows.map(({ n, cls }) => `<div class="who ${cls}"><span>${esc(n)}${cls === 'new' ? ' <span class="muted small">new</span>' : ''}</span>
        <button class="ghost" data-name="${esc(n)}" aria-label="${cls === 'gone' ? 'Keep' : 'Remove'} ${esc(n)}">${cls === 'gone' ? 'Undo' : '✕'}</button></div>`).join('') : '<p class="muted small">No reviewers yet.</p>';
      $('#save').disabled = !add.size && !remove.size;
      if (add.size || remove.size) $('#list').setAttribute('data-dirty', '');
      else $('#list').removeAttribute('data-dirty');
    }

    get(site.url('api/board'), waitIn('#list')).then(({ body: d }) => {
      if (!B.alive()) return;
      current = d.reviewers || [];
      render();
    }).catch(() => { if (B.alive()) $('#list').innerHTML = '<p class="muted">Offline. Is the Mac awake?</p>'; });

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
      if (!B.alive()) return;
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

    const installForm = $('#installForm');
    const installScript = $('#installScript');
    const installSave = $('#installSave');
    const installStatus = $('#installStatus');
    let savedScript = '';
    get(site.url('api/install-script'), waitIn('#installStatus')).then(({ body: d }) => {
      if (!B.alive()) return;
      installScript.value = savedScript = d.install_script || '';
      installScript.disabled = false;
      installStatus.textContent = '';
    }).catch(() => { installStatus.textContent = 'Offline. Is the Mac awake?'; });
    B.on(installScript, 'input', () => {
      const dirty = installScript.value !== savedScript;
      installSave.disabled = !dirty;
      if (dirty) installForm.setAttribute('data-dirty', '');
      else installForm.removeAttribute('data-dirty');
    });
    B.on(installForm, 'submit', async (ev) => {
      ev.preventDefault();
      installSave.disabled = true;
      installScript.disabled = true;
      try {
        const r = await fetch(site.url('api/install-script'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ install_script: installScript.value }) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error);
        savedScript = out.install_script;
        installForm.removeAttribute('data-dirty');
        installStatus.textContent = savedScript ? 'Saved.' : 'Install builds are off.';
      } catch (e) { installStatus.textContent = e.message || 'Could not save. Is the Mac awake?'; }
      installScript.disabled = false;
      installSave.disabled = installScript.value === savedScript;
    });

    // Saving writes board.json through POST api/rules, whose `rules {scope: "board"}` event wakes Claude to acknowledge
    // the change; replies show below, newest first.
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
    }).catch(() => { $('#rules').innerHTML = '<p class="muted">Offline. Is the Mac awake?</p>'; });
    B.watch((events) => {
      $('#rulesReplies').innerHTML = (events || []).slice(0, 3).map((e) => `<div class="reply">${e.reply ? (e.reply.html ?? '') : '<span class="muted small">Waiting for Claude…</span>'}</div>`).join('');
    }, { kind: 'rules' });
  }),
};
