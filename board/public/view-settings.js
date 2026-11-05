// Board Settings, a modal the app shell (shell.js) mounts over its board for /<route>/settings.html.
// Saving reviewers sends a `reviewers` event {add: [name], remove: [name]}; the server removes names itself and the list
// redraws from its answer, while Claude finds each new person's Slack and GitHub accounts, adds them with board.mjs
// reviewers, and replies. Tickets save on each change, and Done, ✕,
// Escape and the backdrop wait for that save to land before closing. An unsaved edit marks [data-dirty], and the shell
// asks before closing the modal then.
(globalThis.AppViews ||= {}).settings = {
  className: 'view-settings',
  title: () => 'Board Settings',
  markup: (view, { siteTitle = '' } = {}) => `<dialog class="settings-modal" id="boardSettingsModal" aria-labelledby="boardSettingsTitle"><div class="settings-head"><div><h2 id="boardSettingsTitle" tabindex="-1">Board settings</h2><p class="muted small">${BoardUI.esc(siteTitle)}</p></div><button type="button" class="ghost" data-settings-dismiss aria-label="Close board settings">✕</button></div>
<div class="set settings-body">
  <h2>Repo</h2>
  <button type="button" class="who repo-row" id="boardRepo" aria-haspopup="dialog" disabled><span id="boardRepoValue">Loading…</span><span class="muted small" id="boardRepoChange">Change ›</span></button>
  <p class="muted small" id="boardRepoStatus"></p>
  <h2>Tickets</h2>
  <p class="muted small">Every card on this board has a ticket from here. A new card gets a new ticket unless you name one.</p>
  <form id="ticketsForm" class="tk-section"><div id="boardTickets">Loading…</div></form>
  <p class="muted small" id="ticketsStatus" role="status"></p>
  <h2>Auto</h2>
  <label class="who" for="autoPull"><span><span>Auto implement Todo cards</span>
    <span class="muted small sub">Claude grills each card that lands in Todo, and starts a Todo card as soon as it’s ready and nothing blocks or holds it, while an implementer slot is free.</span></span>
    <input type="checkbox" class="toggle" id="autoPull" disabled></label>
  <p class="muted small" id="autoPullStatus" role="status"></p>
  <label class="who" for="maxImplementers"><span><span>Maximum parallel implementers</span>
    <span class="muted small sub">Cards building or waiting in Orchestrator review count. Grills and cards waiting on you don’t.</span></span>
    <input type="number" class="count" id="maxImplementers" min="1" max="99" step="1" inputmode="numeric" disabled></label>
  <p class="muted small" id="maxImplementersStatus" role="status"></p>
  <label class="who" for="maxPlanners"><span><span>Maximum parallel planners</span>
    <span class="muted small sub">Grills and prototypes running at once. A card that lands in Todo past it waits its turn.</span></span>
    <input type="number" class="count" id="maxPlanners" min="1" max="99" step="1" inputmode="numeric" disabled></label>
  <p class="muted small" id="maxPlannersStatus" role="status"></p>
  <label class="who" for="autoBuild"><span><span>Auto serve</span>
    <span class="muted small sub" id="autoBuildSub">${BoardUI.esc(BoardUI.tryWords('web').autoSub)}</span></span>
    <input type="checkbox" class="toggle" id="autoBuild" disabled></label>
  <p class="muted small" id="autoBuildStatus" role="status"></p>
  <label class="who" for="autoReview"><span><span>Auto review</span>
    <span class="muted small sub">Claude reviews teammates’ PRs that touch this board’s work. May use a lot of usage.</span></span>
    <input type="checkbox" class="toggle" id="autoReview" disabled></label>
  <p class="muted small" id="autoReviewStatus" role="status"></p>
  <div id="prsRow" hidden><label class="who" for="prs"><span><span>PRs</span>
    <span class="muted small sub">Each card opens a PR. Off, no PR opens: each card lands on main and main is pushed.</span></span>
    <input type="checkbox" class="toggle" id="prs" disabled></label>
  <p class="muted small" id="prsStatus" role="status"></p></div>
  <label class="who" for="autoMerge"><span><span>Auto-merge</span>
    <span class="muted small sub" id="autoMergeSub">Claude merges a PR once it is approved, green and merges cleanly.</span></span>
    <input type="checkbox" class="toggle" id="autoMerge" disabled></label>
  <p class="muted small" id="autoMergeStatus" role="status"></p>
  <div id="skipDraftRow" hidden><label class="who" for="skipDraft"><span><span>Skip the draft</span>
    <span class="muted small sub">A builder’s PR opens as a draft and is marked ready for review once CI passes, so it goes to reviewers without waiting for you.</span></span>
    <input type="checkbox" class="toggle" id="skipDraft" disabled></label>
  <p class="muted small">With Auto-merge on too, a builder’s PR can merge once reviewers approve it, without you seeing it.</p>
  <p class="muted small" id="skipDraftStatus" role="status"></p></div>
  <label class="who" for="autoTriage"><span><span>Triage overnight</span>
    <span class="muted small sub">Once a night, when two or more cards wait on your answers, Claude merges their overlapping questions and duplicate cards, and tidies Todo.</span></span>
    <input type="checkbox" class="toggle" id="autoTriage" disabled></label>
  <p class="muted small" id="autoTriageStatus" role="status"></p>
  <label class="who" for="idleNotification"><span><span>Idle notification</span>
    <span class="muted small sub">Pushes once when the board has been idle for 15 minutes, with what closed since the last one.</span></span>
    <input type="checkbox" class="toggle" id="idleNotification" disabled></label>
  <p class="muted small" id="idleNotificationStatus" role="status"></p>
  <p class="muted small">The hub runs <code>.kickflip/build</code> from each card’s branch and from main. Claude wrote it when it set up this board; if builds break, file a card.</p>
  <h2>Permissions</h2>
  <div id="permissions"><p class="muted small">Loading…</p></div>
  <div id="reviewersSection" hidden>
  <h2>Reviewers</h2>
  <p class="muted small">Everyone here gets each PR link on this board once it's ready, and the weekday digest. Someone you add also gets the links of PRs already in review.</p>
  <div id="list"><p class="muted small">Loading…</p></div>
  <form class="add" id="addForm">
    <input id="addName" placeholder="Add someone by name" autocomplete="off">
    <button type="submit">Add</button>
  </form>
  <div class="row" style="margin-top:12px"><span class="muted small" id="saveStatus"></span><button class="primary" id="save" disabled>Save</button></div>
  <div class="replies" id="replies"></div>
  </div>
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
      <p>Keep its folder, cards, threads and notes on the host. Reopen later from Hub → Closed boards.</p>
      <div class="close-board-warning" id="closeBoardWarning"></div>
      <label for="closeBoardTyped">Type <strong id="closeBoardTypeName"></strong> to confirm.<input id="closeBoardTyped" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <p class="muted small" id="closeBoardError" role="status"></p>
      <div class="row sheet-actions"><button type="button" id="closeBoardCancel">Cancel</button><button class="danger" type="submit" id="closeBoardConfirm" disabled>Close board</button></div>
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
    let dismissing = false;
    function close() {
      if (tickets) saveTickets();
      if (!savingTickets) { ctx.dismiss?.(); return; }
      if (dismissing) return;
      dismissing = true;
      savingTickets.then(() => { dismissing = false; if (B.alive()) ctx.dismiss?.(); });
    }
    B.on(modal, 'cancel', (e) => { e.preventDefault(); close(); });
    B.on(modal, 'click', (e) => {
      if (e.target.closest?.('[data-settings-dismiss]')) close();
      else if (e.target === modal) {
        const rect = modal.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close();
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
      closeRow.disabled = false;
      $('#closeBoardReason').textContent = '';
      $('#closeBoardName').textContent = d.title;
      $('#closeBoardTypeName').textContent = d.title;
      const warnings = [...(d.prs || []).map((p) => `<li>PR #${esc(p.pr)} (${esc(p.repo)}) — ${esc(p.wave)}/${esc(p.id)}</li>`),
        ...(d.builders || []).map((b) => `<li>${esc(b.label)} — ${esc(b.key)}</li>`)];
      $('#closeBoardWarning').innerHTML = warnings.length ? `<h3>This board still has active work</h3><ul>${warnings.join('')}</ul><p>Running implementers will be stopped with a note. PRs stay open on GitHub; this board stops polling them.</p>` : '';
    };
    loadClosure().catch(() => { if (B.alive()) $('#closeBoardReason').textContent = 'Could not load Close board. Is the host awake?'; });
    B.on(closeRow, 'click', async () => {
      if (closing || closeRow.disabled) return;
      closeRow.disabled = true;
      try {
        await loadClosure();
        if (!B.alive()) return;
        typed.value = '';
        closeConfirm.disabled = true;
        $('#closeBoardError').textContent = '';
        unfit?.();
        unfit = BoardDialogs.fitSheet(closeSheet);
        closeSheet.showModal();
        typed.focus();
      } catch { $('#closeBoardReason').textContent = 'Could not load Close board. Is the host awake?'; closeRow.disabled = false; }
    });
    B.on(typed, 'input', () => { closeConfirm.disabled = closing || typed.value !== closure?.title; });
    B.on($('#closeBoardCancel'), 'click', () => closeSheet.close());
    B.on(closeSheet, 'close', () => { unfit?.(); unfit = null; });
    B.on(closeSheet, 'click', (e) => { if (e.target === closeSheet && !closing) closeSheet.close(); });
    B.on($('#closeBoardForm'), 'submit', async (e) => {
      e.preventDefault();
      if (closing || typed.value !== closure?.title) return;
      closing = true;
      // Close board waits until the hub has stopped the board's session and server.
      const post = (async () => {
        const r = await fetch('/_hub/close-board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route, name: typed.value }) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Could not close board.');
        return out;
      })();
      try {
        const out = await BoardUI.waitOn(closeConfirm, post);
        if (!B.alive()) return;
        closeSheet.close();
        ctx.sidebarChanged?.();
        ctx.open(out.next || '/_hub/');
      } catch (error) {
        if (B.alive()) $('#closeBoardError').textContent = error.message || 'Could not close board. Is the host awake?';
      } finally {
        closing = false;
        closeConfirm.disabled = typed.value !== closure?.title;
      }
    });
    B.atUnmount(() => { unfit?.(); closeSheet.close(); });
    const repoURL = `/_hub/board-repo/${encodeURIComponent(B.route)}`;
    let repo = {}, closeRepo = () => {};
    let tickets, savedTickets, savingTickets = null, ticketsTouched = false;
    // PRs shows on a board on GitHub that builds from its shared clone; a local board never opens PRs. Skip the draft and
    // Reviewers show only while cards open PRs, and Auto-merge says what it merges
    // (docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md, docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
    let prsSetting = true;
    const opensPRs = () => Boolean(repo.github) && !repo.local && prsSetting;
    const syncPRs = () => {
      $('#prsRow').hidden = !repo.github || Boolean(repo.local);
      $('#skipDraftRow').hidden = $('#reviewersSection').hidden = !opensPRs();
      $('#autoMergeSub').textContent = opensPRs() ? 'Claude merges a PR once it is approved, green and merges cleanly.' : 'Lands each verified card on main without waiting for your Merge.';
    };
    const showRepo = () => {
      $('#boardRepoValue').textContent = repo.github || repo.remote ? `${repo.github || repo.remote} · ${repo.branch || 'Branch not recorded'}` : 'No GitHub repo';
      syncPRs();
    };
    get(repoURL).then(({ body }) => {
      if (!B.alive()) return;
      repo = body;
      tickets?.render();
      if (tickets) syncTickets();
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
        tickets?.render();
        if (tickets) syncTickets();
        showRepo();
        $('#boardRepoStatus').textContent = 'Saved. The board’s session has been told.';
      } });
    });
    B.atUnmount(() => closeRepo());
    B.atUnmount(() => tickets?.destroy());
    const ticketsForm = $('#ticketsForm');
    const ticketsStatus = $('#ticketsStatus');
    const unsaved = () => ticketsTouched && JSON.stringify(tickets.read()) !== JSON.stringify(savedTickets);
    function syncTickets() {
      if (unsaved()) ticketsForm.setAttribute('data-dirty', '');
      else ticketsForm.removeAttribute('data-dirty');
    }
    async function postTickets(value) {
      try {
        const r = await fetch(site.url('api/settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tickets: value }) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Could not save tickets.');
        savedTickets = out.settings.tickets;
        return true;
      } catch (e) {
        if (B.alive()) ticketsStatus.textContent = e.message || 'Could not save. Is the host awake?';
        return false;
      }
    }
    // A save waits on the control last tapped or changed, found by selector since ticketsControl redraws it, and every
    // other tickets control is disabled meanwhile (ui.js waitOn).
    let ticketsTapped = '[data-tk-source][aria-pressed="true"]';
    const tapped = (e) => {
      const source = e.target.closest?.('[data-tk-source]');
      if (source) ticketsTapped = `[data-tk-source="${source.dataset.tkSource}"]`;
      else if (e.target.dataset?.tk) ticketsTapped = `[data-tk="${e.target.dataset.tk}"]`;
    };
    B.on(ticketsForm, 'click', tapped, true);
    B.on(ticketsForm, 'change', tapped, true);
    // One save at a time: a change made while one is out saves once it lands.
    function saveTickets() {
      syncTickets();
      if (savingTickets || !unsaved() || !tickets.valid()) return;
      ticketsStatus.textContent = '';
      LinearKey.doneBusy(modal.querySelectorAll('[data-settings-dismiss]'), true);
      savingTickets = (async () => {
        let saved, value;
        do {
          value = tickets.read();
          saved = await postTickets(value);
        } while (saved && B.alive() && tickets.valid() && JSON.stringify(tickets.read()) !== JSON.stringify(value));
        savingTickets = null;
        if (!B.alive()) return;
        if (saved) ticketsStatus.textContent = 'Saved';
        LinearKey.doneBusy(modal.querySelectorAll('[data-settings-dismiss]'), false);
        syncTickets();
      })();
      BoardUI.waitOn(ticketsForm.querySelector(ticketsTapped) || ticketsForm.querySelector('[data-tk-source][aria-pressed="true"]'), savingTickets,
        { group: ticketsForm.querySelectorAll('button, select, input') });
    }
    B.on(ticketsForm, 'submit', (e) => { e.preventDefault(); saveTickets(); });
    let buildKind = 'web';
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
      buildKind = d.kind || 'web';
      $('#autoBuildSub').textContent = BoardUI.tryWords(buildKind).autoSub;
      current = d.reviewers || [];
      render();
    }).catch(() => { if (B.alive()) $('#list').innerHTML = '<p class="muted">Offline. Is the host awake?</p>'; });

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
        const out = await BoardUI.waitOn($('#save'), site.send('reviewers', { add: [...add], remove: [...remove] }));
        status.textContent = add.size ? 'Sent. Claude updates the list and replies below.' : 'Saved';
        current = out.board.reviewers;
        add.clear(); remove.clear(); render();
      } catch (e) { status.textContent = e?.reason || 'Could not send. Is the host awake?'; }
    });
    B.watch((events) => {
      $('#replies').innerHTML = events.map((e) => `<div class="reply">${e.reply ? (e.reply.html ?? '') : '<span class="muted small">Waiting for Claude…</span>'}</div>`).join('');
    }, { kind: 'reviewers' });

    // The toggle saves at once through POST api/settings, which writes board.json itself, so it takes effect with no
    // session awake (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md).
    const autoMerge = $('#autoMerge');
    const autoMergeStatus = $('#autoMergeStatus');
    const savedCaps = {};
    get(site.url('api/settings'), waitIn('#autoMergeStatus')).then(({ body: d }) => {
      if (!B.alive()) return;
      savedTickets = d.settings?.tickets || null;
      tickets = BoardDialogs.ticketsControl($('#boardTickets'), { value: savedTickets || { source: 'internal', prefix: 'INT' }, repo: () => repo.github || '', title: () => ctx.siteTitle || '',
        loadLinear: async () => (await get('/_hub/api/linear')).body,
        keyState: async () => (await get('/_hub/api/settings')).body.linear,
        change(_value, _valid, { loaded, typing } = {}) {
          if (!loaded) ticketsTouched = true;
          if (typing) syncTickets(); else saveTickets();
        }, createProject: async (team, name) => {
          const r = await fetch('/_hub/linear/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team, name }) });
          const out = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(out.error || 'Could not create the project. Is the host awake?');
          return out;
        } });
      autoMergeStatus.textContent = '';
      autoMerge.checked = d.settings?.auto_merge === true;
      autoMerge.disabled = false;
      $('#autoBuild').checked = d.settings?.auto_build === true;
      $('#autoBuild').disabled = false;
      $('#autoPull').checked = d.settings?.auto_pull === true;
      $('#autoPull').disabled = false;
      for (const [id, key] of [['maxImplementers', 'max_implementers'], ['maxPlanners', 'max_planners']]) {
        $(`#${id}`).value = savedCaps[key] = String(d.settings?.[key]);
        $(`#${id}`).disabled = false;
      }
      $('#autoTriage').checked = d.settings?.auto_triage === true;
      $('#autoTriage').disabled = false;
      $('#autoReview').checked = d.settings?.auto_review === true;
      $('#autoReview').disabled = false;
      $('#idleNotification').checked = d.settings?.idle_notification === true;
      $('#idleNotification').disabled = false;
      $('#skipDraft').checked = d.settings?.skip_draft === true;
      $('#skipDraft').disabled = false;
      $('#prs').checked = prsSetting = d.settings?.prs !== false;
      $('#prs').disabled = false;
      syncPRs();
    }).catch(() => { autoMergeStatus.textContent = ticketsStatus.textContent = 'Offline. Is the host awake?'; });
    // An Auto toggle keeps its face, disabled with a spinner beside it (ui.js waitOn), while POST api/settings saves it.
    // → the saved settings
    const saveToggle = (toggle, body) => BoardUI.waitOn(toggle, (async () => {
      const r = await fetch(site.url('api/settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error);
      return out.settings;
    })());
    B.on(autoMerge, 'change', async () => {
      const want = autoMerge.checked;
      const ask = opensPRs() ? 'Turn on auto-merge? Claude merges each approved PR on this board once CI is green and it merges cleanly, without asking you.'
        : 'Turn on auto-merge? Each verified card lands on main without asking you.';
      if (want && !(await BoardDialogs.confirm(ask))) {
        autoMerge.checked = false;
        return;
      }
      if (!B.alive()) return;
      try {
        autoMerge.checked = (await saveToggle(autoMerge, { auto_merge: want })).auto_merge === true;
        autoMergeStatus.textContent = opensPRs() ? (autoMerge.checked ? 'Saved. Claude merges approved, green PRs itself.' : 'Saved. Approved, green PRs wait for your Merge.')
          : autoMerge.checked ? 'Saved. Each verified card lands on main by itself.' : 'Saved. Each verified card waits for your Merge.';
      } catch (e) {
        autoMerge.checked = !want;
        autoMergeStatus.textContent = e.message || 'Could not save. Is the host awake?';
      }
    });

    B.on($('#autoBuild'), 'change', async () => {
      const toggle = $('#autoBuild');
      const want = toggle.checked;
      try {
        const settings = await saveToggle(toggle, { auto_build: want });
        if (!B.alive()) return;
        toggle.checked = settings.auto_build === true;
        $('#autoBuildStatus').textContent = BoardUI.tryWords(buildKind).saved(toggle.checked);
      } catch (e) {
        if (!B.alive()) return;
        toggle.checked = !want;
        $('#autoBuildStatus').textContent = e.message || 'Could not save. Is the host awake?';
      }
    });

    // These Auto toggles save with no confirmation: docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md,
    // docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md and
    // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md; Idle notification too:
    // docs/adr/2026-11-04-0257-an-idle-board-pushes-once-when-it-has-gone-idle.md.
    const autoToggle = (id, key, saved) => B.on($(`#${id}`), 'change', async () => {
      const toggle = $(`#${id}`);
      const want = toggle.checked;
      try {
        const settings = await saveToggle(toggle, { [key]: want });
        if (!B.alive()) return;
        toggle.checked = settings[key] === true;
        $(`#${id}Status`).textContent = saved(toggle.checked);
      } catch (e) {
        if (!B.alive()) return;
        toggle.checked = !want;
        $(`#${id}Status`).textContent = e.message || 'Could not save. Is the host awake?';
      }
    });
    autoToggle('autoPull', 'auto_pull', (on) => (on ? 'Saved. Claude grills each card that lands in Todo and starts ready ones while an implementer slot is free.' : 'Saved. Todo cards wait for you.'));

    // docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md: Maximum parallel implementers, and
    // Maximum parallel planners (docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md), save on
    // change, waiting on the server like a toggle; a number outside 1 to 99 or a refusal puts the saved one back.
    const capInput = (id, key, saidOf) => B.on($(`#${id}`), 'change', async () => {
      const input = $(`#${id}`);
      const status = $(`#${id}Status`);
      const want = /^\d+$/.test(input.value) ? Number(input.value) : 0;
      if (want < 1 || want > 99) { input.value = savedCaps[key]; status.textContent = 'Pick a whole number from 1 to 99.'; return; }
      try {
        const settings = await saveToggle(input, { [key]: want });
        if (!B.alive()) return;
        input.value = savedCaps[key] = String(settings[key]);
        status.textContent = saidOf(settings[key]);
      } catch (e) {
        if (!B.alive()) return;
        input.value = savedCaps[key];
        status.textContent = e.message || 'Could not save. Is the host awake?';
      }
    });
    capInput('maxImplementers', 'max_implementers', (n) => `Saved. Up to ${n === 1 ? '1 card builds or waits' : `${n} cards build or wait`} in Orchestrator review at once.`);
    capInput('maxPlanners', 'max_planners', (n) => `Saved. Up to ${n === 1 ? '1 grill or prototype runs' : `${n} grills or prototypes run`} at once.`);
    autoToggle('autoReview', 'auto_review', (on) => (on ? 'Saved. When idle, Claude reviews incoming PRs that touch this board’s work.' : 'Saved. Claude leaves incoming PRs alone.'));
    autoToggle('idleNotification', 'idle_notification', (on) => (on ? 'Saved. One push once the board has been idle for 15 minutes.' : 'Saved. No push when the board goes idle.'));
    autoToggle('autoTriage', 'auto_triage', (on) => (on ? 'Saved. Once a night, when cards wait on your answers, Claude triages them.' : 'Saved. Questions and Todo are left as they are.'));
    autoToggle('skipDraft', 'skip_draft', (on) => (on ? 'Saved. A builder’s draft PR is marked ready for review once CI passes.' : 'Saved. A builder’s draft PR waits for your review.'));
    // PRs off needs Push main after a land, which the server checks; its refusal shows in the status line.
    autoToggle('prs', 'prs', (on) => {
      prsSetting = on;
      syncPRs();
      return on ? 'Saved. Each card opens a PR.' : 'Saved. Each card lands on main with no PR, and main is pushed.';
    });

    // Each switch writes or removes one allow rule in the board folder's .claude/settings.local.json through POST
    // api/permissions (docs/adr/2026-11-03-1921-board-settings-grant-a-boards-session-permissions.md); the hub lets only
    // the owner reach the board (docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md). A tap waits on the server with the
    // switch as it was and a spinner beside it, then draws the server's answer.
    const permissions = $('#permissions');
    const REFUSED = {
      denied: (command) => `Auto mode still refused this once: ${command}. Approve it under /permissions, Recently blocked.`,
      asked: (command) => `The session still asked before running ${command}, so it hasn’t picked the rule up yet. It applies once the session restarts.`,
    };
    const permRow = (p) => `<label class="who" for="perm-${esc(p.id)}"><span><span>${esc(p.name)}</span>
      <span class="muted small sub">${esc(p.allows)} Writes <code>${esc(p.rule)}</code></span></span>
      <span class="toggle-slot"><span class="try-spin toggle-spin" aria-hidden="true"></span><input type="checkbox" class="toggle" data-perm="${esc(p.id)}" id="perm-${esc(p.id)}"${p.on ? ' checked' : ''}></span></label>
      <p class="muted small" id="perm-${esc(p.id)}Status" role="status"></p>
      ${p.refused ? `<p class="muted small refused-note">${esc(REFUSED[p.refused.how](p.refused.command))}</p>` : ''}`;
    const drawPermissions = (d) => {
      permissions.innerHTML = d.permissions.map(permRow).join('');
    };
    // A switch whose saved face no answer has drawn in BoardUI's PENDING_LATE_MS: the switches load once and rest.
    function stillWaiting() {
      if (!B.alive()) return;
      B.toast('Still waiting on the board');
      get(site.url('api/permissions')).then(({ ok, body }) => { if (ok && B.alive()) drawPermissions(body); }, () => {});
    }
    get(site.url('api/permissions'), waitIn('#permissions')).then(({ ok, body }) => {
      if (!B.alive()) return;
      if (!ok) { permissions.innerHTML = `<p class="muted small">${esc(body.error || 'Could not load permissions.')}</p>`; return; }
      drawPermissions(body);
    }).catch(() => { if (B.alive()) permissions.innerHTML = '<p class="muted">Offline. Is the host awake?</p>'; });
    B.on(permissions, 'change', async (e) => {
      const toggle = e.target.closest?.('input[data-perm]');
      if (!toggle) return;
      const id = toggle.dataset.perm;
      const on = toggle.checked;
      toggle.checked = !on;
      // The switch spins until the answer is drawn, so it never shows its old face in between
      // (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
      const saving = (async () => {
        const r = await fetch(site.url('api/permissions'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, on }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error);
        if (!B.alive()) return;
        drawPermissions(out);
        $(`#perm-${id}Status`).textContent = on ? 'Saved. The session runs it without asking.' : 'Saved. The session asks first again.';
      })();
      try { await BoardUI.waitOn(toggle, BoardUI.pending.within(saving, stillWaiting)); } catch (error) {
        if (B.alive()) $(`#perm-${id}Status`).textContent = error.message || 'Could not save. Is the host awake?';
      }
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
          if (!r.ok) throw new Error(out.error || 'Could not save. Is the host awake?');
          return { rules: out.rules, message: out.id ? 'Saved. Claude acknowledges it below.' : 'Nothing changed.' };
        },
      });
    }).catch(() => { $('#rules').innerHTML = '<p class="muted">Offline. Is the host awake?</p>'; });
    B.watch((events) => {
      $('#rulesReplies').innerHTML = (events || []).slice(0, 3).map((e) => `<div class="reply">${e.reply ? (e.reply.html ?? '') : '<span class="muted small">Waiting for Claude…</span>'}</div>`).join('');
    }, { kind: 'rules' });
  }),
};
