// Board Settings, a modal the app shell (shell.js) mounts over its board for /<route>/settings.html.
// Saving reviewers sends a `reviewers` event {add: [{name, slack_user, github}], remove: [name]}; the server writes both
// itself and the list redraws from its answer. Add picks a Slack member and a GitHub login from lists the server fetches
// (GET api/reviewer-people), or a typed login, and stays off until both are chosen. Tickets save on each change, and Done, ✕,
// Escape and the backdrop wait for that save to land before closing. An unsaved edit marks [data-dirty], and the shell
// asks before closing the modal then. Sharing (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md)
// lists the hub's GET /_hub/share/<route>, who can look and who was just refused, and saves each Add and ✕ at once
// through POST api/share.
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
  <div id="landingSection" hidden>
  <h2>Landing</h2>
  <p class="muted small" id="landingSub"></p>
  <div class="tk-seg landing-seg" id="landing" role="group" aria-label="Landing">
    <button type="button" data-landing="draft" aria-pressed="false" disabled><span>Draft PR</span><span class="small sub">Opens a draft; you mark it ready.</span></button>
    <button type="button" data-landing="ready" aria-pressed="false" disabled><span>Ready PR</span><span class="small sub">Opens ready for review once CI passes.</span></button>
    <button type="button" data-landing="merge" aria-pressed="false" disabled><span>Merge</span><span class="small sub">No PR; lands on the base branch.</span></button>
  </div>
  <p class="muted small" id="landingStatus" role="status"></p>
  </div>
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
  <label class="who" for="autoMerge"><span><span>Auto-merge</span>
    <span class="muted small sub">Claude merges a PR once it is approved, green and merges cleanly, and lands a build waiting to merge into the base branch.</span></span>
    <input type="checkbox" class="toggle" id="autoMerge" disabled></label>
  <p class="muted small" id="autoMergeStatus" role="status"></p>
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
  <form class="add pick" id="addForm">
    <div class="pick-col"><input id="slackFilter" placeholder="Slack member" autocomplete="off"><div id="slackPeople" class="pick-list"><p class="muted small">Loading…</p></div></div>
    <div class="pick-col"><input id="githubFilter" placeholder="GitHub login" autocomplete="off"><div id="githubPeople" class="pick-list"><p class="muted small">Loading…</p></div></div>
    <button type="submit" id="addBtn" disabled>Add</button>
  </form>
  <p class="muted small" id="pickStatus" role="status"></p>
  <div class="row" style="margin-top:12px"><span class="muted small" id="saveStatus"></span><button class="primary" id="save" disabled>Save</button></div>
  </div>
  <h2>Sharing</h2>
  <p class="muted small">People listed here can look at this board, view only. Nothing else on the host opens for them.</p>
  <div id="shareList"><p class="muted small">Loading…</p></div>
  <div id="shareRefused"></div>
  <form class="add" id="shareAdd"><input id="shareLogin" placeholder="Add by login, like name@github" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="submit">Add</button></form>
  <div class="share-reach"><p class="muted small">They also need the host shared to them in Tailscale (<a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener">Tailscale’s Machines page ${BoardUI.LINK_ARROW}</a>). Then send them this link.</p><button type="button" id="shareCopy">Copy link</button></div>
  <p class="muted small" id="shareStatus" role="status"></p>
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
    // Landing shows on a board on GitHub that builds from its shared clone and on the hub board, which builds from its
    // folder, starts on Merge and opens PRs on Draft PR or Ready PR; any other local board never opens PRs. Its choice is
    // the board's prs and skip_draft settings read together: Draft PR, prs on and skip_draft off; Ready PR, both on;
    // Merge, prs off. Reviewers show only while cards open PRs
    // (docs/adr/2026-11-05-0200-landing-is-one-choice-draft-pr-ready-pr-or-merge.md).
    const LANDING = {
      draft: { set: { prs: true, skip_draft: false }, sub: 'Each card opens a draft PR and waits for you to mark it ready for review.', saved: 'Saved. Each card opens a draft PR.' },
      ready: { set: { prs: true, skip_draft: true }, sub: 'Each card opens a PR ready for review, without waiting for you.', saved: 'Saved. Each card opens a PR ready for review.' },
      merge: { set: { prs: false }, sub: 'No PR opens: each card lands on the base branch and the base branch is pushed.', saved: 'Saved. Each card lands on the base branch with no PR, and the base branch is pushed.' },
    };
    let landing = 'draft';
    const landingButtons = () => Object.keys(LANDING).map((value) => $(`[data-landing="${value}"]`));
    const landingOf = (settings) => (settings?.prs === false ? 'merge' : settings?.skip_draft === true ? 'ready' : 'draft');
    const opensPRs = () => Boolean(repo.github) && (!repo.local || Boolean(repo.hub)) && landing !== 'merge';
    const syncPRs = () => {
      $('#landingSection').hidden = !repo.github || (Boolean(repo.local) && !repo.hub);
      $('#reviewersSection').hidden = !opensPRs();
      $('#landingSub').textContent = LANDING[landing].sub;
      for (const button of landingButtons()) button.setAttribute('aria-pressed', String(button === $(`[data-landing="${landing}"]`)));
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
    let githubOf = {};
    const add = new Map();
    const remove = new Set();
    function render() {
      const rows = [...current.map((n) => ({ n, cls: remove.has(n) ? 'gone' : '', github: githubOf[n] })), ...[...add.values()].map((a) => ({ n: a.name, cls: 'new', github: a.github }))];
      $('#list').innerHTML = rows.length ? rows.map(({ n, cls, github }) => `<div class="who ${cls}"><span>${esc(n)}${cls === 'new' ? ' <span class="muted small">new</span>' : ''}${github ? `<span class="muted small sub">github: ${esc(github)}</span>` : ''}</span>
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
      githubOf = d.reviewerGithub || {};
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

    // The pickers: tap a Slack member and a GitHub login (or type one), then Add stages them for Save.
    let people = { slack: [], github: [] };
    const picked = { slack: null, github: '' };
    const fits = (text, filter) => text.toLowerCase().includes(filter.trim().toLowerCase());
    function renderPick() {
      const slackFilter = $('#slackFilter').value, githubFilter = $('#githubFilter').value.trim();
      const taken = new Set([...current, ...add.keys()].map((n) => n.toLowerCase()));
      const slack = (people.slack || []).filter((p) => fits(p.name, slackFilter) && !taken.has(p.name.toLowerCase()));
      $('#slackPeople').innerHTML = people.slack ? slack.map((p) => `<button type="button" class="ghost" data-slack="${esc(p.id)}" data-name="${esc(p.name)}" aria-pressed="${picked.slack?.id === p.id}">${esc(p.name)}</button>`).join('') || '<p class="muted small">No one matches.</p>'
        : `<p class="muted small">${esc(people.slackProblem || 'Slack members are not available.')} <a href="/_hub/settings">Hub settings</a></p>`;
      const logins = people.github.filter((l) => fits(l, githubFilter));
      const typed = githubFilter && !people.github.some((l) => l.toLowerCase() === githubFilter.toLowerCase()) ? [githubFilter] : [];
      $('#githubPeople').innerHTML = [...typed, ...logins].map((l) => `<button type="button" class="ghost" data-github="${esc(l)}" aria-pressed="${picked.github === l}">${typed.includes(l) ? `Use ${esc(l)}` : esc(l)}</button>`).join('')
        + (people.githubProblem ? `<p class="muted small">${esc(people.githubProblem)}</p>` : '');
      $('#addBtn').disabled = !picked.slack || !picked.github;
    }
    get(site.url('api/reviewer-people'), waitIn('#slackPeople')).then(({ body }) => { if (!B.alive()) return; people = { github: [], ...body }; renderPick(); })
      .catch(() => { if (B.alive()) $('#slackPeople').innerHTML = '<p class="muted small">Offline. Is the host awake?</p>'; });
    B.on($('#slackFilter'), 'input', renderPick);
    B.on($('#githubFilter'), 'input', renderPick);
    B.on($('#slackPeople'), 'click', (ev) => {
      const b = ev.target.closest('button[data-slack]');
      if (b) { picked.slack = { id: b.dataset.slack, name: b.dataset.name }; renderPick(); }
    });
    B.on($('#githubPeople'), 'click', (ev) => {
      const b = ev.target.closest('button[data-github]');
      if (b) { picked.github = b.dataset.github; renderPick(); }
    });
    B.on($('#addForm'), 'submit', (ev) => {
      ev.preventDefault();
      if (!picked.slack || !picked.github) return;
      add.set(picked.slack.name, { name: picked.slack.name, slack_user: picked.slack.id, github: picked.github });
      picked.slack = null; picked.github = '';
      $('#slackFilter').value = ''; $('#githubFilter').value = '';
      renderPick();
      render();
    });
    B.on($('#save'), 'click', async () => {
      const status = $('#saveStatus');
      try {
        const out = await BoardUI.waitOn($('#save'), site.send('reviewers', { add: [...add.values()], remove: [...remove] }));
        status.textContent = 'Saved';
        current = out.board.reviewers;
        githubOf = out.board.reviewerGithub || {};
        add.clear(); remove.clear(); render(); renderPick();
      } catch (e) { status.textContent = e?.reason || 'Could not send. Is the host awake?'; }
    });

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
      landing = landingOf(d.settings);
      for (const button of landingButtons()) button.disabled = false;
      syncPRs();
    }).catch(() => { autoMergeStatus.textContent = ticketsStatus.textContent = 'Offline. Is the host awake?'; });
    // An Auto toggle keeps its face, disabled with a spinner beside it (ui.js waitOn), while POST api/settings saves it.
    // → the saved settings
    const saveToggle = (toggle, body, wait) => BoardUI.waitOn(toggle, (async () => {
      const r = await fetch(site.url('api/settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error);
      return out.settings;
    })(), wait);
    B.on(autoMerge, 'change', async () => {
      const want = autoMerge.checked;
      const ask = opensPRs() ? 'Turn on auto-merge? Claude merges each approved PR on this board once CI is green and it merges cleanly, without asking you.'
        : 'Turn on auto-merge? Each verified card lands on the base branch without asking you.';
      if (want && !(await BoardDialogs.confirm(ask))) {
        autoMerge.checked = false;
        return;
      }
      if (!B.alive()) return;
      try {
        autoMerge.checked = (await saveToggle(autoMerge, { auto_merge: want })).auto_merge === true;
        autoMergeStatus.textContent = opensPRs() ? (autoMerge.checked ? 'Saved. Claude merges approved, green PRs itself.' : 'Saved. Approved, green PRs wait for your Merge.')
          : autoMerge.checked ? 'Saved. Each verified card lands on the base branch by itself.' : 'Saved. Each verified card waits for your Merge.';
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
    // A Landing tap saves at once with no confirmation, its choice's settings in one POST. Merge needs Push main after a
    // land, which the server checks; its refusal shows in the status line and the saved choice stays pressed.
    for (const want of Object.keys(LANDING)) B.on($(`[data-landing="${want}"]`), 'click', async () => {
      const button = $(`[data-landing="${want}"]`);
      if (want === landing) return;
      try {
        const settings = await saveToggle(button, LANDING[want].set, { group: landingButtons() });
        if (!B.alive()) return;
        landing = landingOf(settings);
        $('#landingStatus').textContent = LANDING[landing].saved;
      } catch (err) {
        if (!B.alive()) return;
        $('#landingStatus').textContent = err.message || 'Could not save. Is the host awake?';
      }
      syncPRs();
    });

    // Each switch writes or removes one allow rule in the board folder's .claude/settings.local.json through POST
    // api/permissions (docs/adr/2026-11-03-1921-board-settings-grant-a-boards-session-permissions.md); the hub lets only
    // the owner reach the board (docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md). A tap waits on the server with the
    // switch as it was and a spinner beside it, then draws the server's answer.
    // Sharing: each row is the person's name, then their login and when; a login Tailscale sent no name with is its own.
    let sharing = null;
    const shareRow = (title, sub, button) => `<div class="who"><span>${esc(title)}<span class="muted small sub">${sub}</span></span>${button}</div>`;
    const shareWhen = (p) => (p.now ? '<span class="share-now">viewing now</span>' : esc(p.at ? BoardUI.since(p.at) : 'not seen yet'));
    const shareSub = (p, when) => (p.name ? `${esc(p.login)} · ${when}` : when);
    function drawSharing() {
      $('#shareList').innerHTML = sharing.people.length ? sharing.people.map((p) => shareRow(p.name || p.login, shareSub(p, shareWhen(p)),
        `<button type="button" class="ghost" data-share-remove="${esc(p.login)}" aria-label="Remove ${esc(p.name || p.login)}">✕</button>`)).join('') : '<p class="muted small">Nobody yet.</p>';
      $('#shareRefused').innerHTML = sharing.refused.length ? `<p class="muted small">Just refused. Tap to share with them:</p>${sharing.refused.map((r) => shareRow(r.name || r.login, shareSub(r, esc(BoardUI.since(r.at))),
        `<button type="button" data-share-add="${esc(r.login)}">Add</button>`)).join('')}` : '';
    }
    const loadSharing = () => get(`/_hub/share/${encodeURIComponent(route)}`).then(({ ok, body }) => {
      if (!B.alive()) return;
      if (!ok) { $('#shareList').innerHTML = `<p class="muted small">${esc(body.error || 'Could not load sharing.')}</p>`; return; }
      sharing = body;
      drawSharing();
    }).catch(() => { if (B.alive()) $('#shareList').innerHTML = '<p class="muted">Offline. Is the host awake?</p>'; });
    async function saveShare(change) {
      $('#shareStatus').textContent = '';
      try {
        const r = await fetch(site.url('api/share'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error);
        await loadSharing();
        return true;
      } catch (error) {
        if (B.alive()) $('#shareStatus').textContent = error.message || 'Could not save. Is the host awake?';
        return false;
      }
    }
    loadSharing();
    B.on($('#shareList'), 'click', (e) => { const b = e.target.closest?.('[data-share-remove]'); if (b) saveShare({ remove: b.dataset.shareRemove }); });
    B.on($('#shareRefused'), 'click', (e) => { const b = e.target.closest?.('[data-share-add]'); if (b) saveShare({ add: b.dataset.shareAdd }); });
    B.on($('#shareAdd'), 'submit', async (e) => {
      e.preventDefault?.();
      const input = $('#shareLogin');
      const login = input.value.trim();
      if (!login) { $('#shareStatus').textContent = 'Type a login first, like name@github.'; return; }
      if (await saveShare({ add: login }) && B.alive()) input.value = '';
    });
    B.on($('#shareCopy'), 'click', async () => {
      const link = sharing?.link || new URL(`/${encodeURIComponent(route)}/`, location.href).href;
      try { await navigator.clipboard.writeText(link); $('#shareStatus').textContent = `Copied ${link}`; }
      catch { $('#shareStatus').textContent = link; }
    });

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
