// Board Settings, a modal the app shell (shell.js) mounts over its board for /<route>/settings.html.
// Saving reviewers sends a `reviewers` event {add: [{name, slack_user, github}], remove: [name]}; the server writes both
// itself and the list redraws from its answer. Add searches the Slack members the server fetches (GET api/reviewer-people), then
// takes a GitHub login guessed from the name or typed, and stays off until a member and a login are there. Tickets save on each change, and Done, ✕,
// Escape and the backdrop wait for that save to land before closing. An unsaved edit marks [data-dirty], and the shell
// asks before closing the modal then.
(globalThis.AppViews ||= {}).settings = {
  className: 'view-settings',
  // The Schedules list (GET api/schedules, board/schedules.mjs): each schedule's text, then its cadence, next fire, last
  // task and a skipped fire; editing, the id of the row open with its text and cadence boxes. It wears the rules
  // editor's rows.
  schedulesHtml(list, { editing = null } = {}) {
    const { esc } = BoardUI;
    if (!list.length) return '<p class="muted small rule-empty">No schedules on this board yet.</p>';
    const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return list.map((s) => {
      if (s.id === editing) {
        return `<div class="rule editing" data-schedule="${esc(s.id)}"><textarea class="schedule-text" rows="3" aria-label="What it asks">${esc(s.text)}</textarea>
          <input class="schedule-cadence" value="${esc(s.cadence)}" aria-label="Cadence" placeholder="every 4h, or at 09:00 weekdays" autocomplete="off" spellcheck="false">
          <div class="rule-actions"><button type="button" class="primary" data-act="save">Save</button><button type="button" data-act="cancel">Cancel</button></div></div>`;
      }
      const meta = [esc(s.cadence), `next ${esc(when(s.due_at))}`,
        s.last ? `last <a href="#selectedCard=${encodeURIComponent(s.last)}">${esc(s.last_ref || s.last)}</a>` : 'not fired yet',
        s.skipped ? `skipped ${esc(when(s.skipped.at))}: its last task wasn’t Done` : ''].filter(Boolean);
      return `<div class="rule" data-schedule="${esc(s.id)}"><div class="rule-body"><div class="rule-text">${esc(s.text)}</div><div class="rule-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div></div>
        <div class="rule-actions"><button type="button" data-act="edit" aria-label="Edit schedule ${esc(s.id)}">Edit</button><button type="button" class="ghost" data-act="remove" aria-label="Remove schedule ${esc(s.id)}">✕</button></div></div>`;
    }).join('');
  },
  title: () => 'Board Settings',
  markup: (view, { siteTitle = '' } = {}) => `<dialog class="settings-modal" id="boardSettingsModal" aria-labelledby="boardSettingsTitle"><div class="settings-head"><div><h2 id="boardSettingsTitle" tabindex="-1">Board settings</h2><p class="muted small">${BoardUI.esc(siteTitle)}</p></div><button type="button" class="ghost" data-settings-dismiss aria-label="Close board settings">✕</button></div>
<div class="set settings-body">
  <h2>Pause board</h2>
  <div class="hub-view"><div class="group" id="pauseBoard"><p class="muted small block">Loading…</p></div></div>
  <p class="muted small">Running steps finish. No new builders, planners or pulls start on this board until then, as when usage reaches the pause line.</p>
  <p class="muted small" id="pauseBoardStatus" role="status"></p>
  <h2>Description</h2>
  <label class="who" for="boardDescription"><span><span>Description</span>
    <span class="muted small sub">The hub routes requests to this board by it.</span></span>
    <textarea id="boardDescription" rows="3" maxlength="240" disabled></textarea></label>
  <p class="muted small" id="boardDescriptionSource"></p>
  <p class="muted small" id="boardDescriptionStatus" role="status"></p>
  <h2>Repo</h2>
  <button type="button" class="who repo-row" id="boardRepo" aria-haspopup="dialog" disabled><span id="boardRepoValue">Loading…</span><span class="muted small" id="boardRepoChange">Change ›</span></button>
  <p class="muted small" id="boardRepoStatus"></p>
  <label class="who" for="buildTarget"><span><span>Build target</span>
    <span class="muted small sub" id="buildTargetSub">The hub runs <code>.kickflip/build</code> from each task’s branch and from main. Claude wrote it when it set up this board; if builds break, file a task.</span></span>
    <select id="buildTarget" disabled><option value="">Default</option></select></label>
  <p class="muted small" id="buildTargetStatus" role="status"></p>
  <h2>Scripts</h2>
  <p class="muted small">Where the build and release scripts live.</p>
  <div class="tk-seg" id="scriptsSource" role="group" aria-label="Scripts source">
    <button type="button" data-scripts-source="repo" aria-pressed="false" disabled><span>Repo</span><span class="small sub">The repo’s <code>.kickflip/</code>, from each task’s branch.</span></button>
    <button type="button" data-scripts-source="kickflip" aria-pressed="false" disabled><span>Kickflip</span><span class="small sub">One copy, kept here, for every task and main.</span></button>
  </div>
  <p class="muted small" id="scriptsSourceStatus" role="status"></p>
  <div id="scriptsBoxes" hidden>
    <div id="scriptsList"></div>
    <form id="scriptAdd" class="row script-add"><label class="muted small" for="scriptTarget">build-</label><input id="scriptTarget" placeholder="target" autocomplete="off" spellcheck="false"><button type="submit">Add build target</button></form>
    <p class="muted small" id="scriptAddStatus" role="status"></p>
  </div>
  <h2>Tickets</h2>
  <p class="muted small">Every task on this board has a ticket from here. A new task gets a new ticket unless you name one.</p>
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
  <details class="overrides" id="overrides"><summary><h2>Overrides<span class="count" id="overridesCount"></span></h2></summary>
  <p class="muted small">This board takes Hub settings’ Board defaults. On or Off here sets one for this board alone.</p>
  <div id="overrideRows"><p class="muted small" id="overridesStatus" role="status">Loading…</p></div>
  </details>
  <h2>Permissions</h2>
  <div id="permissions"><p class="muted small">Loading…</p></div>
  <div id="reviewersSection" hidden>
  <h2>Reviewers</h2>
  <p class="muted small">Everyone here gets each PR link on this board once it's ready, and the weekday digest. Someone you add also gets the links of PRs already in review.</p>
  <div id="list"><p class="muted small">Loading…</p></div>
  <form class="add pick" id="addForm">
    <input id="slackFilter" placeholder="Search Slack members" autocomplete="off">
    <div id="slackPeople" class="pick-list"><p class="muted small">Loading…</p></div>
    <div class="login-row" id="loginRow" hidden><input id="githubFilter" placeholder="GitHub login" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="submit" id="addBtn" disabled>Add</button></div>
  </form>
  <p class="muted small" id="pickStatus" role="status"></p>
  <div class="row" style="margin-top:12px"><span class="muted small" id="saveStatus"></span><button class="primary" id="save" disabled>Save</button></div>
  </div>
  <h2>Rules</h2>
  <p class="muted small">Standing instructions for this board's Claude session. It sees them each time it wakes, and says what changes when you save.</p>
  <div id="rules"><p class="muted small">Loading…</p></div>
  <div class="replies" id="rulesReplies"></div>
  <h2>Schedules</h2>
  <p class="muted small">Instructions this board files as a task on a cadence. Each fire waits until the last one’s task is Done. Ask Claude to add one.</p>
  <div id="schedules" class="rules-editor"><p class="muted small">Loading…</p></div>
  <p class="muted small" id="schedulesStatus" role="status"></p>
  <h2>Board</h2>
  <button class="who close-board-row" id="closeBoard" disabled aria-haspopup="dialog"><span>Close board<span class="muted small sub">Stop its session and server. Keep its tasks, threads and notes.</span></span><span aria-hidden="true">›</span></button>
  <p class="muted small" id="closeBoardReason" role="status">Loading…</p>
  <dialog class="sheet close-board-sheet" id="closeBoardSheet" aria-labelledby="closeBoardTitle">
    <form id="closeBoardForm">
      <div class="grab" aria-hidden="true"></div>
      <h2 id="closeBoardTitle">Close this board?</h2>
      <p id="closeBoardName"></p>
      <ul><li>Stop the board’s session.</li><li>Stop its server.</li><li>Remove its sidebar row and manifest entry.</li></ul>
      <p>Keep its folder, tasks, threads and notes on the host. Reopen later from Hub → Closed boards.</p>
      <div class="close-board-warning" id="closeBoardWarning"></div>
      <label for="closeBoardTyped">Type <strong id="closeBoardTypeName"></strong> to confirm.<input id="closeBoardTyped" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <p class="muted small" id="closeBoardError" role="status"></p>
      <div class="row sheet-actions"><button type="button" id="closeBoardCancel">Cancel</button><button class="danger" type="submit" id="closeBoardConfirm" disabled>Close board</button></div>
    </form>
  </dialog>
</div><div class="settings-footer"><button type="button" data-settings-dismiss>Done</button></div></dialog>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
    const { $, site } = B;
    const { esc, fetchJSON, restartNotice, pageCopy, copyNote, downLanding } = BoardUI;
    // While the board can't be reached, each part reads its last answer here and the whole body turns read only under
    // the copy line, reopening live once the board answers; a part with no copy waits out a restart, then the body shows
    // the landing (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
    const settingsBody = $('.settings-body');
    let readOnly = false;
    function fromCopy(savedAt) {
      if (readOnly) return;
      readOnly = true;
      settingsBody.inert = true;
      settingsBody.insertAdjacentHTML('afterbegin', copyNote('Settings', savedAt));
      // poll: settings-retry
      B.every(5000, () => { fetchJSON(site.url('api/settings'), { limit: 0 }).then(() => { if (B.alive()) ctx.reload(); }, () => {}); });
    }
    function down(e) {
      if (readOnly || root.classList.contains('down')) return;
      root.classList.add('down');
      settingsBody.insertAdjacentHTML('afterbegin', downLanding(e.down));
    }
    const saved = (url, r) => { if (r.ok) pageCopy.save(url, r.body); return r; };
    async function get(url, onWait) {
      try { return saved(url, await fetchJSON(url, { limit: 0, sleep: B.sleep })); } catch {}
      const c = await pageCopy.read(url);
      if (c) { fromCopy(c.savedAt); return { ok: true, status: 200, body: c.body }; }
      try { return saved(url, await fetchJSON(url, { onWait, sleep: B.sleep })); } catch (e) { down(e); throw e; }
    }
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
      else if (BoardUI.onBackdrop(e, modal)) {
        const rect = modal.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close();
      }
    });
    B.atUnmount(() => { unfitModal(); modal.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); });
    B.atUnmount(BoardUI.swipeToDismiss(modal));
    BoardUI.openSheet(modal, { centred: true });
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
      const warnings = [...(d.prs || []).map((p) => `<li>PR #${esc(p.pr)} (${esc(p.repo)}) — ${esc(p.file)}/${esc(p.id)}</li>`),
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
        BoardUI.openSheet(closeSheet);
        B.atUnmount(BoardDialogs.focusField(typed));
      } catch { $('#closeBoardReason').textContent = 'Could not load Close board. Is the host awake?'; closeRow.disabled = false; }
    });
    B.on(typed, 'input', () => { closeConfirm.disabled = closing || typed.value !== closure?.title; });
    B.on($('#closeBoardCancel'), 'click', () => closeSheet.close());
    B.atUnmount(BoardUI.swipeToDismiss(closeSheet));
    B.on(closeSheet, 'close', () => { unfit?.(); unfit = null; });
    B.on(closeSheet, 'click', (e) => { if (BoardUI.onBackdrop(e, closeSheet) && !closing) closeSheet.close(); });
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
      draft: { set: { prs: true, skip_draft: false }, sub: 'Each task opens a draft PR and waits for you to mark it ready for review.', saved: 'Saved. Each task opens a draft PR.' },
      ready: { set: { prs: true, skip_draft: true }, sub: 'Each task opens a PR ready for review, without waiting for you.', saved: 'Saved. Each task opens a PR ready for review.' },
      merge: { set: { prs: false }, sub: 'No PR opens: each task lands on the base branch and the base branch is pushed.', saved: 'Saved. Each task lands on the base branch with no PR, and the base branch is pushed.' },
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
      $('#boardRepoValue').textContent = repo.github || repo.remote ? `${repo.github || repo.remote} · ${repo.branch || 'Branch not recorded'}` : `Local only, lands don’t push · ${repo.branch || 'main'}`;
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
        loadBuildTargets();
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
        savedTickets = out.settings.tickets || { source: 'none' };
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
      paintOverrides();
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

    // The picker: search the Slack members and tap one, then the GitHub login field holds a guess from the name (or what
    // the person types), and Add stages them for Save. people is null while loading, 'failed' once the list can't be read.
    let people = null;
    const picked = { slack: null };
    const fits = (text, filter) => text.toLowerCase().includes(filter.trim().toLowerCase());
    const squash = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
    // The collaborator whose login is a plain spelling of the name: first+last, first, last, or first initial + last.
    function guessLogin(name, logins) {
      const words = name.toLowerCase().split(/\s+/).map(squash).filter(Boolean);
      if (!words.length) return '';
      const first = words[0], last = words.at(-1);
      const spellings = [first + last, first, last, first[0] + last];
      for (const spelling of spellings) {
        const hit = logins.find((l) => squash(l) === spelling);
        if (hit) return hit;
      }
      return '';
    }
    const problem = (text) => `<p class="muted small problem">${esc(text)} <button type="button" class="ghost" data-retry>Retry</button></p>`;
    function renderPick() {
      const taken = new Set([...current, ...add.keys()].map((n) => n.toLowerCase()));
      const list = $('#slackPeople');
      $('#slackFilter').hidden = Boolean(picked.slack);
      $('#loginRow').hidden = !picked.slack;
      if (picked.slack) {
        list.innerHTML = `<span class="chip">${esc(picked.slack.name)} <button type="button" class="ghost" data-unpick aria-label="Choose someone else">✕</button></span>`;
        $('#pickStatus').textContent = people?.githubProblem ? `${people.githubProblem} Type their login.` : '';
      } else if (people === 'failed') list.innerHTML = problem("Couldn't load the list.");
      else if (!people) list.innerHTML = '<p class="muted small">Loading…</p>';
      else if (!people.slack) list.innerHTML = `<p class="muted small">${esc(people.slackProblem || 'Slack members are not available.')} <a href="/_hub/settings">Hub settings</a></p>`;
      else list.innerHTML = people.slack.filter((p) => fits(p.name, $('#slackFilter').value) && !taken.has(p.name.toLowerCase()))
        .map((p) => `<button type="button" class="ghost" data-slack="${esc(p.id)}" data-name="${esc(p.name)}">${esc(p.name)}</button>`).join('') || '<p class="muted small">No one matches.</p>';
      $('#addBtn').disabled = !picked.slack || !$('#githubFilter').value.trim();
    }
    function loadPeople() {
      people = null;
      renderPick();
      // The wait says "Board restarting…" only when the hub marked a restart; any other wait leaves Loading… until the
      // list arrives or the retries give out.
      const wait = (ms, down) => { if (down?.state === 'restarting') $('#slackPeople').innerHTML = restartNotice(); };
      get(site.url('api/reviewer-people'), wait).then(({ ok, body }) => { if (!B.alive()) return; people = ok ? { github: [], ...body } : 'failed'; renderPick(); })
        .catch(() => { if (B.alive()) { people = 'failed'; renderPick(); } });
    }
    loadPeople();
    B.on($('#slackFilter'), 'input', renderPick);
    B.on($('#githubFilter'), 'input', renderPick);
    B.on($('#slackPeople'), 'click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.retry !== undefined) { loadPeople(); return; }
      if (b.dataset.unpick !== undefined) { picked.slack = null; $('#githubFilter').value = ''; renderPick(); return; }
      if (!b.dataset.slack) return;
      picked.slack = { id: b.dataset.slack, name: b.dataset.name };
      $('#githubFilter').value = guessLogin(picked.slack.name, people.github);
      renderPick();
      $('#pickStatus').textContent = $('#githubFilter').value ? 'Guessed from their name. Change it if it is wrong.' : $('#pickStatus').textContent;
      $('#githubFilter').focus?.();
    });
    B.on($('#addForm'), 'submit', (ev) => {
      ev.preventDefault();
      const github = $('#githubFilter').value.trim();
      if (!picked.slack || !github) return;
      add.set(picked.slack.name, { name: picked.slack.name, slack_user: picked.slack.id, github });
      picked.slack = null;
      $('#slackFilter').value = ''; $('#githubFilter').value = '';
      $('#pickStatus').textContent = '';
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

    // docs/adr/2026-11-22-0130-the-auto-settings-are-hub-defaults-a-board-can-override.md
    // Overrides: each Auto setting drawn as Hub settings' Board defaults draws it, with Hub default (its value) first,
    // then On and Off, or a setting's own choices, which override it for this board. A tap saves at once through POST
    // api/settings, which writes board.json itself, so it takes effect with no session awake
    // (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md); Hub default posts null. Only a tap
    // that turns Auto-merge on, or turns Pull in issues on from Off, asks first. The head counts the overrides.
    const OVERRIDES = [
      { key: 'auto_build', label: 'Auto serve', sub: () => BoardUI.tryWords(buildKind).autoSub, saved: (on) => BoardUI.tryWords(buildKind).saved(on) },
      { key: 'auto_review', label: 'Auto review', sub: () => 'Claude reviews teammates’ PRs that touch this board’s work. May use a lot of usage.',
        saved: (on) => (on ? 'Saved. When idle, Claude reviews incoming PRs that touch this board’s work.' : 'Saved. Claude leaves incoming PRs alone.') },
      { key: 'auto_merge', label: 'Auto-merge', sub: () => 'Claude merges a PR once it is approved, green and merges cleanly, and lands a build waiting to merge into the base branch.',
        saved: (on) => (opensPRs() ? (on ? 'Saved. Claude merges approved, green PRs itself.' : 'Saved. Approved, green PRs wait for your Merge.')
          : on ? 'Saved. Each verified task lands on the base branch by itself.' : 'Saved. Each verified task waits for your Merge.') },
      { key: 'idle_notification', label: 'Idle notification', sub: () => 'Pushes once when the board has been idle for 15 minutes, with what closed since the last one.',
        saved: (on) => (on ? 'Saved. One push once the board has been idle for 15 minutes.' : 'Saved. No push when the board goes idle.') },
      // docs/adr/2026-11-22-2221-an-approved-tasks-splits-land-in-todo-as-staging.md
      { key: 'stage_splits', label: 'Automatically stage split tickets', sub: () => 'When the orchestrator splits a task you approved, each split lands in Todo as staged, skipping New.',
        saved: (on) => (on ? 'Saved. Splits of a task you approved land in Todo as staged.' : 'Saved. Splits of a task you approved come in through New.') },
      // docs/adr/2026-11-27-2345-a-board-pulls-in-open-github-issues-no-task-names.md
      { key: 'pull_issues', label: 'Pull in issues', choices: ['off', 'assigned', 'all'], sub: () => 'The hub files each open issue on this board’s GitHub repo that no task names as a task to discuss. Needs GitHub issues as the ticket source.',
        saved: (value) => ({ off: 'Saved. Issues come onto this board only when you add them.', assigned: 'Saved. Open issues assigned to you come in as tasks to discuss.',
          all: 'Saved. Each open issue no task names comes in as a task to discuss.' })[value] },
    ];
    const CHOICE_WORDS = { on: 'On', off: 'Off', assigned: 'Assigned only', all: 'All' };
    const choicesOf = (row) => row.choices || ['on', 'off'];
    // A stored value as its choice: on or off for a switch, the word itself for a setting with choices.
    const wordOf = (value) => (typeof value === 'boolean' ? (value ? 'on' : 'off') : value);
    const valueOf = (row, word) => (row.choices ? word : word === 'on');
    // auto: {settings, overrides, defaults} from api/settings, null until it answers.
    let auto = null;
    const choiceOf = (key) => (key in auto.overrides ? wordOf(auto.overrides[key]) : 'default');
    function paintOverrides() {
      if (!auto) return;
      const rows = $('#overrideRows');
      if (!rows.querySelector('[data-override]')) {
        rows.innerHTML = OVERRIDES.map((row) => `<div class="model-control" data-override-row="${row.key}"><span class="model-label">${esc(row.label)}</span>`
          + `<div class="model-seg" role="group" aria-label="${esc(row.label)}">${['default', ...choicesOf(row)].map((v) => `<button type="button" data-override="${row.key}" value="${v}"></button>`).join('')}</div>`
          + `<p class="u-share-desc" data-override-sub="${row.key}"></p><p class="muted small" id="${row.key}Status" role="status"></p></div>`).join('');
      }
      for (const { key, sub } of OVERRIDES) {
        for (const button of rows.querySelectorAll(`[data-override="${key}"]`)) {
          button.textContent = button.value === 'default' ? `Hub default (${CHOICE_WORDS[wordOf(auto.defaults[key])]})` : CHOICE_WORDS[button.value];
          button.setAttribute('aria-pressed', String(button.value === choiceOf(key)));
        }
        rows.querySelector(`[data-override-sub="${key}"]`).textContent = sub();
      }
      const n = Object.keys(auto.overrides).length;
      $('#overridesCount').textContent = ` · ${n || 'none'}`;
    }
    // docs/adr/2026-11-27-2345-a-board-pulls-in-open-github-issues-no-task-names.md: turning Pull in issues on from Off
    // counts the open issues it would bring in (GET api/issue-backlog) and asks whether to take them all or only new
    // ones. → all, now, none for a board that can't pull (its tickets aren't GitHub issues), or null to save nothing.
    async function backlogAsk(mode, status) {
      status.textContent = 'Counting open issues…';
      const r = await fetch(site.url(`api/issue-backlog?mode=${mode}`));
      const out = await r.json().catch(() => ({}));
      status.textContent = '';
      if (!r.ok) throw new Error(out.error || 'Could not count the open issues. Is the host awake?');
      if (!out.backlog) return 'none';
      const { count, more } = out.backlog;
      if (!count) return 'all';
      const n = `${count}${more ? '+' : ''}`;
      return BoardDialogs.choose(`Pull in ${n} open issue${count === 1 && !more ? '' : 's'}?`,
        `${n} open issue${count === 1 && !more ? '' : 's'} on this board’s repo ${count === 1 && !more ? 'is' : 'are'} on no task${mode === 'assigned' ? ' and assigned to you' : ''}. Pull them all in now, or only issues opened from now on?`,
        [{ value: 'all', label: `Pull all ${n}` }, { value: 'now', label: 'Only new ones' }]);
    }
    B.on($('#overrideRows'), 'click', async (e) => {
      const button = e.target.closest?.('[data-override]');
      if (!button || !auto || button.disabled) return;
      const key = button.dataset.override, want = button.value;
      if (want === choiceOf(key)) return;
      const row = OVERRIDES.find((o) => o.key === key);
      const on = want === 'default' ? auto.defaults[key] : valueOf(row, want);
      const status = $(`#${key}Status`);
      const ask = opensPRs() ? 'Turn on auto-merge? Claude merges each approved PR on this board once CI is green and it merges cleanly, without asking you.'
        : 'Turn on auto-merge? Each verified task lands on the base branch without asking you.';
      if (key === 'auto_merge' && on && !auto.settings.auto_merge && !(await BoardDialogs.confirm(ask))) return;
      if (!B.alive()) return;
      const change = { [key]: want === 'default' ? null : on };
      try {
        if (key === 'pull_issues' && auto.settings.pull_issues === 'off' && on !== 'off') {
          const from = await backlogAsk(on, status);
          if (!from || !B.alive()) return;
          if (from !== 'none') change.pull_issues_since = from === 'now' ? 'now' : null;
        }
        auto = await postSettings(button, change, { group: $('#overrideRows').querySelectorAll(`[data-override="${key}"]`) });
        if (!B.alive()) return;
        paintOverrides();
        status.textContent = row.saved(auto.settings[key]);
      } catch (err) {
        if (B.alive()) status.textContent = err.message || 'Could not save. Is the host awake?';
      }
    });
    let buildTarget = null, buildTargets = null, scriptsSource = null;
    // Pause board (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md): the hub's duration
    // picker (hub-kit.js) with the Block sheet's chips, Forever included, posting {pause} to api/pause at once. A Forever
    // pause lasts until Resume.
    const pauseBox = $('#pauseBoard');
    const pickers = HubKit.durationPickers(B);
    let pauseChoices = [];
    const pausedWords = (end, now) => (end === 'forever' ? 'until you resume' : `until ${BoardUI.heldUntilWords(end, now)}`);
    function paintPause(pausedUntil) {
      const now = new Date();
      const choices = pauseChoices.map((c) => ({ value: c.value, label: c.label, until: pausedWords(c.ms === null ? 'forever' : new Date(now.getTime() + c.ms), now) }));
      pauseBox.innerHTML = HubKit.durationPicker({ id: 'pauseBoard', title: 'Pause board', icon: '', action: site.url('api/pause'), name: 'pause', button: 'Resume',
        choices: pausedUntil ? null : choices, on: pausedUntil ? { title: `Paused ${pausedWords(pausedUntil === 'forever' ? 'forever' : new Date(pausedUntil), now)}` } : null });
      pickers.painted();
    }
    B.on(pauseBox, 'submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const pause = e.submitter?.value ?? form.querySelector('input[type="hidden"]')?.value;
      const status = $('#pauseBoardStatus');
      try {
        const out = await BoardUI.waitOn(e.submitter || form.querySelector('input:not([type="hidden"])'), (async () => {
          const r = await fetch(site.url('api/pause'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pause }) });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.error);
          return body;
        })(), { group: pauseBox.querySelectorAll('button') });
        if (!B.alive()) return;
        paintPause(out.paused_until);
        status.textContent = out.paused_until ? 'Paused. New work on this board waits.' : 'Resumed. New work starts again.';
        ctx.sidebarChanged?.();
      } catch (error) {
        if (B.alive()) status.textContent = error.message || 'Could not save. Is the host awake?';
      }
    });
    get(site.url('api/settings'), waitIn('#overridesStatus')).then(({ body: d }) => {
      pauseChoices = d.pause_choices || [];
      paintPause(d.paused_until);
      if (!B.alive()) return;
      savedTickets = d.settings?.tickets || { source: 'none' };
      tickets = BoardDialogs.ticketsControl($('#boardTickets'), { value: savedTickets, repo: () => repo.github || '', title: () => ctx.siteTitle || '',
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
      auto = { settings: d.settings, overrides: d.overrides, defaults: d.defaults };
      paintOverrides();
      buildTarget = d.settings?.build_target || '';
      scriptsSource = d.settings?.scripts || 'repo';
      showBuildTargets();
      landing = landingOf(d.settings);
      for (const button of landingButtons()) button.disabled = false;
      syncPRs();
    }).catch(() => { const status = $('#overridesStatus'); if (status) status.textContent = 'Offline. Is the host awake?'; ticketsStatus.textContent = 'Offline. Is the host awake?'; });
    // A setting's control keeps its face, disabled with a spinner beside it (ui.js waitOn), while POST api/settings saves
    // it. → {settings, overrides, defaults}
    const postSettings = (toggle, body, wait) => BoardUI.waitOn(toggle, (async () => {
      const r = await fetch(site.url('api/settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error);
      return out;
    })(), wait);
    // → the saved settings
    const saveToggle = async (toggle, body, wait) => (await postSettings(toggle, body, wait)).settings;

    // Build target lists the repo's .kickflip/build-* scripts at main's tip and saves a pick at once, null for the
    // default .kickflip/build (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md).
    // A saved target the tip no longer has stays listed, marked, so the picker shows what the hub runs.
    // A board whose scripts are in kickflip lists and runs its site's scripts/build-* instead
    // (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md).
    const buildNameOf = (target) => (target ? `build-${target}` : 'build');
    const buildScriptOf = (target) => (scriptsSource === 'kickflip' ? `kickflip’s ${buildNameOf(target)}` : `.kickflip/${buildNameOf(target)}`);
    const buildTargetSub = (target) => (scriptsSource === 'kickflip'
      ? `The hub runs kickflip’s <code>${esc(buildNameOf(target))}</code> for each task and for main. Edit it under Scripts.`
      : `The hub runs <code>${esc(buildScriptOf(target))}</code> from each task’s branch and from main. Claude wrote it when it set up this board; if builds break, file a task.`);
    const showBuildTargets = () => {
      if (buildTarget === null || buildTargets === null) return;
      const select = $('#buildTarget');
      const names = buildTargets.includes(buildTarget) || !buildTarget ? buildTargets : [...buildTargets, buildTarget];
      const missing = scriptsSource === 'kickflip' ? 'not in kickflip' : 'not on main';
      select.innerHTML = [['', 'Default'], ...names.map((t) => [t, buildTargets.includes(t) ? t : `${t} (${missing})`])]
        .map(([value, label]) => `<option value="${esc(value)}"${value && value === buildTarget ? ' selected' : ''}>${esc(label)}</option>`).join('');
      select.value = buildTarget;
      select.disabled = false;
      $('#buildTargetSub').innerHTML = buildTargetSub(buildTarget);
    };
    // A new repo brings its own scripts, so a repo save lists them again.
    const loadBuildTargets = () => get(site.url('api/build-targets')).then(({ body }) => {
      if (!B.alive()) return;
      buildTargets = body.targets;
      showBuildTargets();
    }).catch(() => { $('#buildTargetStatus').textContent = 'Could not list the repo’s build scripts. Is the host awake?'; });
    loadBuildTargets();
    B.on($('#buildTarget'), 'change', async () => {
      const select = $('#buildTarget');
      try {
        const settings = await saveToggle(select, { build_target: select.value || null });
        if (!B.alive()) return;
        buildTarget = settings.build_target || '';
        showBuildTargets();
        $('#buildTargetStatus').textContent = `Saved. The hub runs ${buildScriptOf(buildTarget)} for each task and main.`;
      } catch (e) {
        if (!B.alive()) return;
        select.value = buildTarget;
        $('#buildTargetStatus').textContent = e.message || 'Could not save. Is the host awake?';
      }
    });

    // Scripts (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md): a tap on Repo or Kickflip
    // saves the source at once through POST api/settings {scripts}. Repo shows while main has any of the board's
    // scripts or the board runs them from the repo. While the source is kickflip, each of its scripts is a code box whose
    // Save replaces the file through POST api/scripts; Add build target opens an empty box for build-<target>, which the
    // server keeps once saved. An unsaved box marks #scriptsList [data-dirty]. A source move or a save lists the build
    // targets and Run release script's switch again, since both follow the source's scripts.
    let scriptsView = null;
    const scriptDrafts = new Map();
    // As the server's kickflipScripts sorts (shared/a-to-z.mjs).
    const scriptOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    const scriptSources = () => ['repo', 'kickflip'].map((value) => $(`[data-scripts-source="${value}"]`));
    const savedText = (name) => scriptsView.scripts.find((s) => s.name === name)?.text ?? '';
    const scriptNames = () => {
      const added = [...scriptDrafts.keys()].filter((name) => !scriptsView.scripts.some((s) => s.name === name));
      const builds = [...scriptsView.scripts.map((s) => s.name), ...added].filter((name) => name.startsWith('build-')).sort(scriptOrder.compare);
      return ['build', ...new Set(builds), 'release', 'test'];
    };
    const markScriptsDirty = () => {
      const dirty = [...scriptDrafts].some(([name, text]) => text !== savedText(name));
      if (dirty) $('#scriptsList').setAttribute('data-dirty', ''); else $('#scriptsList').removeAttribute('data-dirty');
    };
    const showScripts = () => {
      if (!scriptsView || scriptsSource === null) return;
      for (const button of scriptSources()) {
        button.disabled = false;
        button.setAttribute('aria-pressed', String(button.dataset.scriptsSource === scriptsSource));
      }
      $('[data-scripts-source="repo"]').hidden = !scriptsView.repo.length && scriptsSource !== 'repo';
      $('#scriptsBoxes').hidden = scriptsSource !== 'kickflip';
      const list = $('#scriptsList');
      list.innerHTML = scriptNames().map((name) => `<div class="script-box"><label class="small" for="script-${esc(name)}"><code>${esc(name)}</code></label>
        <textarea id="script-${esc(name)}" rows="8" spellcheck="false" autocomplete="off" data-script="${esc(name)}"></textarea>
        <div class="row"><button type="button" data-script-save="${esc(name)}" disabled>Save</button></div>
        <p class="muted small" id="script-${esc(name)}Status" role="status"></p></div>`).join('');
      for (const name of scriptNames()) {
        const text = scriptDrafts.get(name) ?? savedText(name);
        $(`[data-script="${name}"]`).value = text;
        $(`[data-script-save="${name}"]`).disabled = text === savedText(name);
      }
      markScriptsDirty();
    };
    const savedWords = (name) => (name === 'release' ? 'Saved. The next release task’s land runs it.' : name === 'test' ? 'Saved. The next land runs it.'
      : name === buildNameOf(buildTarget) ? 'Saved. Main rebuilds with it; each task takes it from its next build.' : 'Saved. Pick it under Build target to run it.');
    const reloadPermissions = () => get(site.url('api/permissions')).then(({ ok, body }) => { if (ok && B.alive()) drawPermissions(body); }, () => {});
    const scriptsChanged = () => { loadBuildTargets(); reloadPermissions(); };
    get(site.url('api/scripts')).then(({ ok, body }) => {
      if (!B.alive()) return;
      if (!ok) { $('#scriptsSourceStatus').textContent = body.error || 'Could not read the scripts.'; return; }
      scriptsView = body;
      scriptsSource ??= body.source;
      showScripts();
    }).catch(() => { if (B.alive()) $('#scriptsSourceStatus').textContent = 'Could not read the scripts. Is the host awake?'; });
    for (const button of scriptSources()) B.on(button, 'click', async () => {
      const want = button.dataset.scriptsSource;
      if (want === scriptsSource) return;
      try {
        const settings = await saveToggle(button, { scripts: want }, { group: scriptSources() });
        if (!B.alive()) return;
        scriptsSource = settings.scripts || 'repo';
        showScripts();
        showBuildTargets();
        scriptsChanged();
        $('#scriptsSourceStatus').textContent = scriptsSource === 'kickflip' ? 'Saved. The hub runs kickflip’s scripts for each task and main.'
          : 'Saved. The hub runs the repo’s .kickflip/ scripts for each task and main.';
      } catch (e) {
        if (B.alive()) $('#scriptsSourceStatus').textContent = e.message || 'Could not save. Is the host awake?';
      }
    });
    B.on($('#scriptsList'), 'input', (e) => {
      const box = e.target.closest?.('textarea[data-script]');
      if (!box) return;
      const name = box.dataset.script;
      scriptDrafts.set(name, box.value);
      $(`[data-script-save="${name}"]`).disabled = box.value === savedText(name);
      markScriptsDirty();
    });
    B.on($('#scriptsList'), 'click', async (e) => {
      const button = e.target.closest?.('[data-script-save]');
      if (!button) return;
      const name = button.dataset.scriptSave;
      const text = $(`[data-script="${name}"]`).value;
      try {
        const out = await BoardUI.waitOn(button, (async () => {
          const r = await fetch(site.url('api/scripts'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, text }) });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.error);
          return body;
        })());
        if (!B.alive()) return;
        scriptsView = out;
        if (scriptDrafts.get(name) === text) scriptDrafts.delete(name);
        showScripts();
        scriptsChanged();
        $(`[id="script-${name}Status"]`).textContent = savedWords(name);
      } catch (err) {
        if (B.alive()) $(`[id="script-${name}Status"]`).textContent = err.message || 'Could not save. Is the host awake?';
      }
    });
    B.on($('#scriptAdd'), 'submit', (e) => {
      e.preventDefault?.();
      const input = $('#scriptTarget');
      const target = input.value.trim();
      if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(target)) { $('#scriptAddStatus').textContent = 'A target is letters, digits, “.”, “_” or “-”.'; return; }
      $('#scriptAddStatus').textContent = '';
      input.value = '';
      const name = `build-${target}`;
      if (!scriptNames().includes(name)) scriptDrafts.set(name, '');
      showScripts();
      $(`[data-script="${name}"]`).focus?.();
    });

    // Description saves on blur, with no Save or Cancel; an empty one is refused and the saved text comes back. The
    // source line says how it was last set (store.mjs readBoardDescription).
    const descriptionBox = $('#boardDescription');
    let savedDescription = '';
    const SOURCES = { 'new-board': 'Set at New board', triage: 'From triage, approved', settings: 'Edited here' };
    const showDescription = ({ description, source, at }) => {
      descriptionBox.value = savedDescription = description;
      descriptionBox.disabled = false;
      const day = at ? new Date(at) : null;
      $('#boardDescriptionSource').textContent = SOURCES[source] && day ? `${SOURCES[source]} · ${day.getMonth() + 1}/${day.getDate()}` : '';
    };
    get(site.url('api/description')).then(({ body }) => { if (B.alive()) showDescription(body); }, () => {});
    B.on(descriptionBox, 'blur', async () => {
      const status = $('#boardDescriptionStatus');
      const want = descriptionBox.value.trim();
      if (want === savedDescription) { descriptionBox.value = want; return; }
      if (!want) { descriptionBox.value = savedDescription; status.textContent = 'A board needs a description'; return; }
      try {
        const r = await fetch(site.url('api/description'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: want }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error);
        if (!B.alive()) return;
        showDescription(out);
        status.textContent = 'Saved. The hub routes by it from the next request.';
      } catch (e) {
        if (!B.alive()) return;
        descriptionBox.value = savedDescription;
        status.textContent = e.message || 'Could not save. Is the host awake?';
      }
    });
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
    // switch as it was and a spinner beside it, then draws the server's answer. A switch the server calls unavailable,
    // such as Run release script in a repo with no .kickflip/release, is disabled with the reason while it is off.
    const permissions = $('#permissions');
    const REFUSED = {
      denied: (command) => `Auto mode still refused this once: ${command}. Approve it under /permissions, Recently blocked.`,
      asked: (command) => `The session still asked before running ${command}, so it hasn’t picked the rule up yet. It applies once the session restarts.`,
    };
    const permRow = (p) => `<label class="who" for="perm-${esc(p.id)}"><span><span>${esc(p.name)}</span>
      <span class="muted small sub">${p.unavailable ? `${esc(p.unavailable)}. ` : ''}${esc(p.allows)} Writes <code>${esc(p.rule)}</code></span></span>
      <span class="toggle-slot"><span class="try-spin toggle-spin" aria-hidden="true"></span><input type="checkbox" class="toggle" data-perm="${esc(p.id)}" id="perm-${esc(p.id)}"${p.on ? ' checked' : ''}${p.unavailable && !p.on ? ' disabled' : ''}></span></label>
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
    // Read when the page opens and on each of its board's change signals, which a reply's write sends
    // (docs/adr/2026-11-15-1921-the-browsers-polls-ride-the-change-stream.md).
    const readReplies = () => site.events({ kind: 'rules' }).then((events) => {
      if (B.alive()) $('#rulesReplies').innerHTML = events.slice(0, 3).map((e) => `<div class="reply${e.reply?.md ? ' md' : ''}">${e.reply ? BoardUI.replyBody(e.reply) : '<span class="muted small">Waiting for Claude…</span>'}</div>`).join('');
    }, () => {});
    readReplies();
    if (ctx.signal) B.own(ctx.signal(readReplies));

    // Schedules: the CLI adds them; here each is edited (Save sends its text and cadence) or removed, through POST
    // api/schedules, whose answer redraws the list. An open edit marks [data-dirty].
    const schedulesEl = $('#schedules');
    const schedulesStatus = $('#schedulesStatus');
    let schedules = [];
    let editingSchedule = null;
    function drawSchedules() {
      schedulesEl.innerHTML = AppViews.settings.schedulesHtml(schedules, { editing: editingSchedule });
      if (editingSchedule) schedulesEl.dataset.dirty = ''; else delete schedulesEl.dataset.dirty;
    }
    async function sendSchedule(body) {
      schedulesStatus.textContent = 'Saving…';
      try {
        const r = await fetch(site.url('api/schedules'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || 'Could not save. Is the host awake?');
        if (!B.alive()) return;
        schedules = out.schedules;
        editingSchedule = null;
        schedulesStatus.textContent = body.remove ? 'Removed.' : 'Saved.';
        drawSchedules();
      } catch (e) { if (B.alive()) schedulesStatus.textContent = e.message || 'Could not save. Is the host awake?'; }
    }
    get(site.url('api/schedules'), waitIn('#schedules')).then(({ body }) => {
      if (!B.alive()) return;
      schedules = body.schedules;
      drawSchedules();
    }).catch(() => { schedulesEl.innerHTML = '<p class="muted">Offline. Is the host awake?</p>'; });
    B.on(schedulesEl, 'click', (e) => {
      const btn = e.target.closest?.('button[data-act]');
      const id = btn?.closest('[data-schedule]').dataset.schedule;
      if (!id) return;
      const act = btn.dataset.act;
      if (act === 'edit' || act === 'cancel') { editingSchedule = act === 'edit' ? id : null; schedulesStatus.textContent = ''; drawSchedules(); return; }
      if (act === 'remove') { sendSchedule({ id, remove: true }); return; }
      sendSchedule({ id, text: $('.schedule-text').value, cadence: $('.schedule-cadence').value });
    });
  }),
};
