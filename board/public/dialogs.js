// Native confirmations cannot label their actions on iOS; labelled confirmations use a modal sheet.
// Load before any page script that asks (docs/adr/0023-a-card-can-be-held-and-every-card-button-confirms.md).
(function () {
  function ticketsControl(root, { value = { source: 'internal', prefix: 'INT' }, repo = () => '', title = () => '', linear = {}, isNew = false, change = () => {} } = {}) {
    const { esc } = BoardUI;
    const draft = { prefix: 'INT', ...value };
    const read = () => draft.source === 'internal' ? { source: 'internal', prefix: draft.prefix || 'INT' }
      : draft.source === 'github' ? { source: 'github' }
      : { source: 'linear', workspace: linear.workspace || draft.workspace, team: draft.team, project: draft.project };
    const valid = () => draft.source === 'internal' ? /^[A-Z]{2,6}$/.test(draft.prefix || 'INT')
      : draft.source === 'github' ? Boolean(repo()) : Boolean(linear.set && draft.team && draft.project && draft.project !== '__new');
    function render() {
      const segment = `<div class="tk-seg" role="group" aria-label="Ticket source">${[['linear', 'Linear'], ['github', 'GitHub issues'], ['internal', 'Internal']].map(([source, name]) => `<button type="button" data-tk-source="${source}" aria-pressed="${draft.source === source}">${name}</button>`).join('')}</div>`;
      let detail;
      if (draft.source === 'internal') detail = `<label class="tk-field"><span>Prefix</span><input data-tk="prefix" value="${esc(draft.prefix)}" placeholder="INT" maxlength="6" pattern="[A-Z]{2,6}" title="2–6 uppercase letters" autocapitalize="characters" autocomplete="off" spellcheck="false"></label><p class="muted small" data-tk-example>Cards number ${esc(draft.prefix || 'INT')}-1, ${esc(draft.prefix || 'INT')}-2… on this board. The badge opens the card.</p>`;
      else if (draft.source === 'github') detail = `<div class="who tk-static"><span>Issues in ${esc(repo())}<span class="muted small sub">${isNew ? 'The repo chosen above' : 'The board’s repo, set above'}. A new card opens an issue there; its badge reads #41.</span></span></div>`;
      else if (!linear.set) detail = '<a class="who tk-hublink" href="/_hub/#linear"><span>Add a Linear key on Hub<span class="muted small sub">Linear lists its teams and projects with your API key, kept on this Mac.</span></span><span aria-hidden="true">›</span></a>';
      else detail = `<div class="tk-grid"><label class="tk-field"><span>Team</span><select data-tk="team">${(linear.teams || []).map((t) => `<option value="${esc(t.key)}"${t.key === draft.team ? ' selected' : ''}>${esc(t.key)} · ${esc(t.name)}</option>`).join('')}</select></label><label class="tk-field"><span>Project</span><select data-tk="project">${(linear.projects || []).filter((p) => p.team === draft.team).map((p) => `<option value="${esc(p.id)}"${p.id === draft.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new"${draft.project === '__new' ? ' selected' : ''}>New project…</option></select></label></div>${draft.project === '__new' ? `<div class="tk-new"><input data-tk="newName" value="${esc(draft.newName ?? title())}" aria-label="New Linear project name" placeholder="Project name" autocomplete="off"><button type="button" disabled>Create</button></div>` : ''}`;
      root.innerHTML = `${segment}<div class="tk-detail">${detail}</div>`;
      if (draft.source === 'linear' && linear.set) {
        root.querySelector('[data-tk="team"]').value = draft.team || '';
        root.querySelector('[data-tk="project"]').value = draft.project || '';
      }
    }
    const click = (e) => {
      const button = e.target.closest('[data-tk-source]');
      if (!button) return;
      draft.source = button.dataset.tkSource;
      if (draft.source === 'linear') {
        draft.team ||= linear.teams?.[0]?.key;
        draft.project ||= isNew ? '__new' : linear.projects?.find((p) => p.team === draft.team)?.id;
      }
      render(); root.querySelector(`[data-tk-source="${draft.source}"]`).focus(); change(read(), valid());
    };
    const input = (e) => {
      const field = e.target.dataset.tk;
      if (!field) return;
      draft[field] = field === 'prefix' ? e.target.value.toUpperCase() : e.target.value;
      if (field === 'prefix') e.target.value = draft.prefix;
      if (field === 'team') draft.project = isNew ? '__new' : linear.projects?.find((p) => p.team === draft.team)?.id;
      if (field === 'team' || field === 'project') render();
      if (field === 'prefix') root.querySelector('[data-tk-example]').textContent = `Cards number ${draft.prefix || 'INT'}-1, ${draft.prefix || 'INT'}-2… on this board. The badge opens the card.`;
      change(read(), valid());
    };
    root.addEventListener('click', click);
    root.addEventListener('input', input);
    root.addEventListener('change', input);
    render();
    return { read, valid, render, nameChanged() { const field = root.querySelector('[data-tk="newName"]'); if (field && draft.newName === undefined) field.value = title(); },
      destroy() { root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', input); } };
  }
  let close = null;
  function sheet(message, { ok, cancel = 'Cancel', signal }) {
    close?.(false);
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const el = document.createElement('dialog');
      el.setAttribute('class', 'confirm-sheet');
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'confirmSheetText');
      el.innerHTML = '<div class="box"><p id="confirmSheetText"></p><button type="button" data-answer="ok"></button></div>'
        + '<div class="box"><button type="button" class="cancel" data-answer="cancel"></button></div>';
      el.querySelector('p').textContent = message;
      el.querySelector('[data-answer="ok"]').textContent = ok;
      el.querySelector('[data-answer="cancel"]').textContent = cancel;
      let settled = false;
      const abort = () => done(false);
      function done(yes) {
        if (settled) return;
        settled = true;
        close = null;
        signal?.removeEventListener('abort', abort);
        el.close();
        el.remove();
        if (previous?.isConnected) previous.focus();
        resolve(yes);
      }
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-answer]');
        if (b || e.target === el) done(b?.dataset.answer === 'ok');
      });
      el.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      el.addEventListener('close', () => done(false));
      signal?.addEventListener('abort', abort, { once: true });
      document.body.appendChild(el);
      el.showModal();
      el.querySelector('.cancel').focus();
      close = done;
    });
  }
  function fitSheet(sheet) {
    const vv = window.visualViewport;
    // iOS keeps fixed elements on the layout viewport; --kb is the part covered by its keyboard.
    const fit = () => {
      const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      sheet.style.setProperty('--kb', kb + 'px');
      sheet.style.setProperty('--vh', (vv ? vv.height : window.innerHeight) + 'px');
      sheet.classList.toggle('kb', kb > 0);
    };
    // iOS scrolls the page to show a focused field even under a modal sheet, and then draws the sheet cut off above the
    // keyboard with the board below it, so the page keeps its scroll position. innerHeight reads short during that
    // scroll and no resize follows the restore, so --kb is measured again once the keyboard has settled.
    const y = window.scrollY;
    let settle = 0;
    const pin = () => {
      if (window.scrollY === y) return;
      window.scrollTo(window.scrollX, y);
      clearTimeout(settle);
      settle = setTimeout(fit, 350);
    };
    sheet.classList.add('keyboard-sheet');
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', pin);
    return () => {
      clearTimeout(settle);
      vv?.removeEventListener('resize', fit);
      vv?.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
      window.removeEventListener('scroll', pin);
    };
  }
  function repoSheet({ current, save, onClose = () => {} }) {
    if (document.getElementById('newBoardSheet')) return () => {};
    const previous = document.activeElement;
    const el = document.createElement('dialog');
    el.setAttribute('id', 'newBoardSheet');
    el.setAttribute('class', 'sheet');
    el.setAttribute('aria-labelledby', 'newBoardTitle');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const draft = { name: '', purpose: '', github: '', branch: '', tickets: { source: 'internal', prefix: 'INT' } };
    let tickets;
    let repos = [], pasted, selected, edited = false, sending = false, closed = false, generation = 0, lookupTimer;
    const controller = new AbortController();
    el.innerHTML = `<form class="nb-form"><div class="sheet-head"><h2 id="newBoardTitle" tabindex="-1" autofocus>${current ? 'Change repo' : 'New board'}</h2><button type="button" data-cancel-new aria-label="Close sheet">✕</button></div><div data-repo-content></div><p class="nb-error" role="alert" hidden></p><div class="nb-actions sheet-actions"><button type="button" data-cancel-new>Cancel</button><button type="submit" class="primary" hidden disabled>${current ? 'Use repo' : 'Start'}</button></div></form>`;
    const content = el.querySelector('[data-repo-content]');
    const form = el.querySelector('form');
    const start = el.querySelector('[type="submit"]');
    const error = el.querySelector('[role="alert"]');
    const field = (name) => el.querySelector(`[name="${name}"]`);
    const request = async (url, options = {}) => {
      const r = await fetch(url, { ...options, signal: controller.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load repos. Try again.');
      return d;
    };
    const fail = (e) => { if (!closed) { error.textContent = e.message; error.hidden = false; } };
    function sync() { start.disabled = sending || !draft.github || !draft.branch || (!current && (!draft.name.trim() || !tickets?.valid())); }
    const row = (r, highlighted = false) => `<button type="button" class="nb-repo${highlighted ? ' nb-repo-highlight' : ''}" data-repo="${esc(r.github)}"><strong>${esc(r.github)}</strong>${r.listed === false ? '<span class="nb-repo-tag">Not in your list</span>' : ''}<span class="nb-help">${r.private ? 'Private' : 'Public'} · <time datetime="${esc(r.pushedAt)}">${r.pushedAt ? `Pushed ${esc(new Date(r.pushedAt).toLocaleString())}` : r.listed === false ? 'Last push unknown' : 'No pushes yet'}</time></span><span class="nb-help">${esc(r.description)}</span><span class="nb-local">${r.cloned ? `✓ In .repos${r.shared.length ? ` · shared with ${esc(r.shared.map((b) => b.title).join(', '))}` : ' · already cloned'}` : 'Not cloned in .repos'}</span></button>`;
    const results = (html) => { el.querySelector('[data-repo-results]').innerHTML = html; };
    function rows(query = '') {
      const list = repos.filter((r) => `${r.github} ${r.description}`.toLowerCase().includes(query.trim().toLowerCase()));
      results(`<p class="nb-help" role="status">${list.length} of ${repos.length} repos · Newest push first</p><div class="nb-repo-list">${list.map((r) => row(r)).join('')}</div>${list.length ? '' : '<p class="nb-help">No matching repos. Try an owner or repo name.</p>'}`);
    }
    function search(value) {
      const version = ++generation;
      clearTimeout(lookupTimer);
      pasted = null;
      const q = value.trim();
      const host = /^(?:[a-z][a-z\d+.-]*:\/\/(?:[^@/\s]+@)?|[^@/\s]+@)([^/:?#\s]+)/i.exec(q);
      const reason = (name, message) => results(`<div class="nb-box nb-box-no" role="alert"><span><strong>${esc(name)}</strong><span class="nb-why">${esc(message)}</span></span></div>`);
      if (host && !/^(?:www\.)?github\.com$/i.test(host[1])) {
        reason(q.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/^[^@/\s]+@/, '').replace(/:/, '/').replace(/\.git$/i, ''), 'Only GitHub repos work here.');
        return;
      }
      const link = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s?#]+\/[^/\s?#]+)(?:\/[^\s]*)?(?:[?#][^\s]*)?$/i.exec(q);
      const bare = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(q);
      if (!link && !host && !bare) { rows(q); return; }
      if (host && !link) { reason(q, 'That link doesn’t name a repo. Use github.com/owner/name.'); return; }
      if (bare && repos.some((r) => `${r.github} ${r.description}`.toLowerCase().includes(q.toLowerCase()))) { rows(q); return; }
      const github = link ? link[1].replace(/\.git$/i, '') : q;
      const listed = repos.find((r) => r.github.toLowerCase() === github.toLowerCase());
      if (listed) { results(`<p class="nb-help" role="status">Already in your list</p><div class="nb-repo-list">${row(listed, true)}</div>`); return; }
      results(`<p class="nb-help" role="status">Checking the hub can reach it…</p><div class="nb-box"><span class="nb-spin" aria-hidden="true"></span><span><strong>${esc(github)}</strong><span class="nb-help">Checking…</span></span></div>`);
      const check = async () => {
        try {
          const repo = await request(`/_hub/repo?github=${encodeURIComponent(github)}`);
          if (closed || generation !== version) return;
          pasted = repo;
          results(`<p class="nb-help" role="status">From your link</p><div class="nb-repo-list">${row(repo)}</div>`);
        } catch (e) { if (!closed && generation === version) reason(github, e.message); }
      };
      if (bare) lookupTimer = setTimeout(check, 500);
      else check();
    }
    async function picker(fresh = false) {
      tickets?.destroy();
      const version = ++generation;
      clearTimeout(lookupTimer);
      pasted = null;
      selected = null;
      start.hidden = true;
      error.hidden = true;
      content.innerHTML = '<p class="nb-next">1 · Choose a repo</p><p role="status">Loading repos…</p>';
      try {
        const d = await request(`/_hub/repos${fresh ? '?fresh=1' : ''}`);
        if (closed || generation !== version) return;
        if (!d.signedIn) {
          content.innerHTML = '<h3>GitHub isn’t connected</h3><p>gh isn’t signed in on the Mac running Kickflip. Sign in there to see your repos.</p><code>gh auth login</code><p><button type="button" data-check-auth>Check again</button></p>';
          return;
        }
        repos = d.repos;
        content.innerHTML = '<p class="nb-next">1 · Choose a repo</p><p>Choose the GitHub repo this board will work on.</p><label class="nb-field"><span>Search repos or paste a GitHub link</span><input name="search" type="search" placeholder="Search or paste owner/name…" autocomplete="off" autocapitalize="off" spellcheck="false"></label><div data-repo-results></div>';
        rows();
      } catch (e) { fail(e); content.innerHTML = '<button type="button" data-check-auth>Try again</button>'; }
    }
    async function pick(github) {
      selected = repos.find((r) => r.github === github) || (pasted?.github === github ? pasted : null);
      if (!selected) return;
      const version = ++generation;
      clearTimeout(lookupTimer);
      draft.github = github;
      draft.branch = '';
      if (!edited) draft.name = github.split('/')[1];
      error.hidden = true;
      const shared = selected.shared.map((b) => b.title).join(', ');
      content.innerHTML = `<button type="button" data-back-repos>‹ Back</button><p class="nb-next">${current ? 'Repo details' : '2 · Board details'}</p><div class="nb-selected"><strong>${esc(github)}</strong><span class="nb-help">${selected.private ? 'Private' : 'Public'}</span><p>${selected.cloned ? shared ? `Shared with ${esc(shared)}` : 'Already cloned in .repos' : 'Clones to'}<code class="nb-clone">${esc(selected.clone)}</code></p></div><label class="nb-field"><span>Default branch for this board</span><select name="branch" disabled><option value="">Loading branches…</option></select><span class="nb-help" data-branch-help></span></label><p class="nb-next">Each board’s builders work in separate worktrees off this clone. Sharing the clone doesn’t share their working files.</p>${current ? '<p class="nb-next">New builders and GitHub links will use the selected repo.</p>' : `<label class="nb-field"><span>Name</span><input name="name" type="text" value="${esc(draft.name)}" required maxlength="60" autocomplete="off"></label><label class="nb-field"><span>What it’s for</span><input name="purpose" type="text" value="${esc(draft.purpose)}" maxlength="240"><span class="nb-help">One line to get the board started. Optional.</span></label><p class="nb-next">The hub ${selected.cloned ? 'reuses the clone' : 'clones the repo'} and starts your board. You can keep using your other boards.</p>`}`;
      if (!current) {
        content.querySelectorAll('.nb-next')[content.querySelectorAll('.nb-next').length - 1].insertAdjacentHTML('beforebegin', '<div class="nb-field tk-section" role="group" aria-labelledby="nbTicketsLabel"><span id="nbTicketsLabel">Tickets</span><span class="nb-help">Where this board’s cards get their tickets. You can change it in Board settings.</span><div data-board-tickets></div></div>');
        tickets = ticketsControl(content.querySelector('[data-board-tickets]'), { value: draft.tickets, repo: () => draft.github, title: () => draft.name.trim(), isNew: true, change(value) { draft.tickets = value; sync(); } });
      }
      start.hidden = false;
      sync();
      try {
        const d = await request(`/_hub/branches?github=${encodeURIComponent(github)}`);
        if (closed || generation !== version) return;
        draft.branch = current?.github === github && d.branches.includes(current.branch) ? current.branch : d.defaultBranch;
        if (!d.branches.includes(draft.branch)) draft.branch = d.branches[0] || '';
        field('branch').innerHTML = d.branches.map((b) => `<option value="${esc(b)}"${b === draft.branch ? ' selected' : ''}>${esc(b)}${b === d.defaultBranch ? ' (repo default)' : ''}</option>`).join('');
        field('branch').value = draft.branch;
        field('branch').disabled = false;
        el.querySelector('[data-branch-help]').textContent = draft.branch ? `New builders branch from ${draft.branch}.` : 'This repo has no branches yet.';
        sync();
      } catch (e) { fail(e); }
    }
    const done = () => { if (!sending) el.close(); };
    form.addEventListener('click', (e) => {
      if (sending) return;
      if (e.target.closest('[data-cancel-new]')) done();
      else if (e.target.closest('[data-check-auth]')) picker(true);
      else if (e.target.closest('[data-back-repos]')) picker();
      else { const row = e.target.closest('[data-repo]'); if (row) pick(row.dataset.repo); }
    });
    form.addEventListener('input', (e) => {
      if (e.target.getAttribute('name') === 'search') { search(e.target.value); return; }
      if (e.target.getAttribute('name') === 'name') { draft.name = e.target.value; edited = true; tickets?.nameChanged(); }
      if (e.target.getAttribute('name') === 'purpose') draft.purpose = e.target.value;
      sync();
    });
    form.addEventListener('change', (e) => {
      if (e.target.getAttribute('name') === 'branch') {
        draft.branch = e.target.value;
        el.querySelector('[data-branch-help]').textContent = `New builders branch from ${draft.branch}.`;
        sync();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (sending || start.disabled || !selected) return;
      sending = true;
      sync();
      error.hidden = true;
      try {
        await save(current ? { github: draft.github, branch: draft.branch } : { name: draft.name.trim(), purpose: draft.purpose.trim(), github: draft.github, branch: draft.branch, tickets: tickets.read() }, selected);
        sending = false;
        el.close();
      } catch (e) { sending = false; fail(e); sync(); }
    });
    el.addEventListener('cancel', (e) => { e.preventDefault(); done(); });
    el.addEventListener('click', (e) => { if (e.target === el) done(); });
    el.addEventListener('close', () => {
      if (closed) return;
      closed = true;
      tickets?.destroy();
      clearTimeout(lookupTimer);
      controller.abort();
      stopFitting();
      el.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      onClose();
    });
    document.body.appendChild(el);
    const stopFitting = fitSheet(el);
    el.showModal();
    el.querySelector('h2').focus({ preventScroll: true });
    picker();
    return () => { sending = false; el.close(); };
  }
  const confirm = (message, labels) => (labels?.signal?.aborted ? Promise.resolve(false)
    : labels?.ok ? sheet(message, labels) : Promise.resolve(window.confirm(message)));
  const notice = (message) => { window.alert(message); return Promise.resolve(); };
  globalThis.BoardDialogs = { confirm, notice, fitSheet, repoSheet, ticketsControl };
})();
