// Every confirmation and notice is the browser's own window.confirm or window.alert; no page imitates a native dialog.
// Load before any page script that asks (docs/adr/2026-11-03-0259-confirmations-are-the-browsers-own.md).
(function () {
  // linear: Hub's /_hub/api/linear answer, else loadLinear() fetches it once Linear is the source. Linear is picked only
  // while Hub's key works; tapping it without one opens Hub's key modal over the page (linear-key.js,
  // docs/adr/2026-11-02-1712-a-board-picks-linear-only-while-hubs-key-works.md). A New board's "New project…" reads as
  // new_project, which the hub creates on Start; Board Settings creates it with createProject. change(value, valid,
  // {loaded, typing}) follows each change: loaded when only Linear's lists arrived, typing while a text field is being typed in.
  // GitHub issues needs repo(), the board's GitHub owner/name: without one, as on a board whose repo is another git
  // remote, it can't be picked and says why (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
  // With keyState(), Hub's /_hub/api/settings `linear`, as Board Settings passes it, the source row reads its live state
  // as a status word (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md).
  function ticketsControl(root, { value = { source: 'none' }, repo = () => '', title = () => '', linear = null, loadLinear, isNew = false, change = () => {}, createProject, keyState } = {}) {
    const { esc } = BoardUI;
    const draft = { ...value };
    let creating = false, createError = '', destroyed = false, asking = false, noGithub = false, key = null;
    const works = () => Boolean(linear?.set && !linear.refused);
    const keyWorks = () => Boolean(key?.set && !key.refused);
    const keyWord = () => (keyWorks() ? 'linear key saved' : key.refused ? 'Linear refused the key' : 'no Linear key');
    const statusWord = () => (draft.source === 'linear' && keyWorks() ? 'linear · connected' : `${draft.source} · ${keyWord()}`);
    function status() {
      if (!key) return '';
      const on = draft.source === 'linear' && keyWorks();
      return `<div class="tk-status${on ? ' on' : ''}" data-tk-status role="status">${BoardUI.iconText('dot', on ? 'green' : 'grey', statusWord())}</div>`;
    }
    async function load() {
      linear = { loading: true };
      render();
      linear = await loadLinear().catch((e) => ({ set: true, error: e.message || 'Is the host awake?' }));
    }
    const workspace = () => linear?.url_key ?? linear?.workspace ?? draft.workspace;
    const newName = () => (draft.newName ?? title()).trim();
    const ready = () => works() && !linear.error;
    const read = () => draft.source === 'none' ? { source: 'none' }
      : draft.source === 'github' ? { source: 'github', ...(draft.account ? { account: draft.account } : {}) }
      : !ready() ? { source: 'linear', workspace: draft.workspace, team: draft.team, project: draft.project }
      : draft.project === '__new' && isNew ? { source: 'linear', workspace: workspace(), team: draft.team, new_project: newName() }
      : { source: 'linear', workspace: workspace(), team: draft.team, project: draft.project };
    const valid = () => draft.source === 'none' ? true
      : draft.source === 'github' ? Boolean(repo())
      : Boolean(ready() && draft.team && draft.project && (draft.project !== '__new' || (isNew && newName())));
    const pickDefaults = () => {
      if (draft.source !== 'linear' || !ready()) return;
      if (!linear.teams?.some((t) => t.key === draft.team)) draft.team = linear.teams?.[0]?.key;
      if (draft.project === '__new' || linear.projects?.some((p) => p.id === draft.project && p.team === draft.team)) return;
      draft.project = isNew ? '__new' : linear.projects?.find((p) => p.team === draft.team)?.id;
    };
    // A board already on Linear whose Hub key is missing or refused keeps its source and shows why.
    function needsKey() {
      const why = linear.refused ? 'Linear refused Hub’s key' : 'Hub has no Linear key';
      return `<p class="muted small" role="status">${why}, so this board can’t list Linear’s teams or create issues there.</p><p><button type="button" data-tk-key>Add Hub’s Linear key</button></p>`;
    }
    function linearDetail() {
      if (!linear || linear.loading) return '<p class="muted small" role="status">Loading Linear…</p>';
      if (!works()) return needsKey();
      if (linear.error) return `<p class="muted small" role="alert">Couldn’t list Linear’s teams: ${esc(linear.error)}</p>`;
      const project = linear.projects?.find((p) => p.id === draft.project);
      const team = esc(draft.team || '');
      const note = draft.project === '__new'
        ? (isNew ? `<p class="muted small">Start creates the project in the ${team} team on Linear.</p>` : `<p class="muted small">Creates the project in the ${team} team on Linear.</p>`)
        : `<p class="muted small">A task gets a ${team} issue in ${esc(project?.name || draft.project || '')}, in the ${esc(linear.workspace || workspace())} workspace from Hub’s key, when it goes ready to build. Its badge opens it in Linear.</p>`;
      return `<div class="tk-grid"><label class="tk-field"><span>Team</span><select data-tk="team">${(linear.teams || []).map((t) => `<option value="${esc(t.key)}"${t.key === draft.team ? ' selected' : ''}>${esc(t.key)} · ${esc(t.name)}</option>`).join('')}</select></label><label class="tk-field"><span>Project</span><select data-tk="project">${(linear.projects || []).filter((p) => p.team === draft.team).map((p) => `<option value="${esc(p.id)}"${p.id === draft.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new"${draft.project === '__new' ? ' selected' : ''}>New project…</option></select></label></div>${draft.project === '__new' ? `<div class="tk-new"><input data-tk="newName" value="${esc(draft.newName ?? title())}" aria-label="New Linear project name" placeholder="Project name" maxlength="80" autocomplete="off">${isNew ? '' : `<button type="button" data-tk-create${creating ? BoardUI.BUSY : ''}>Create</button>`}</div>` : ''}${createError ? `<p class="muted small" role="alert">${esc(createError)}</p>` : ''}${note}`;
    }
    function render() {
      const off = !repo();
      const segment = `<div class="tk-seg" role="group" aria-label="Ticket source">${[['linear', 'Linear'], ['github', 'GitHub issues'], ['none', 'None']].map(([source, name]) => `<button type="button" data-tk-source="${source}" aria-pressed="${draft.source === source}"${source === 'github' && off ? ' aria-disabled="true"' : ''}>${name}</button>`).join('')}</div>`;
      const why = `<p class="muted small" role="status">GitHub issues need a repo on GitHub, and ${isNew ? 'the repo chosen above' : 'this board’s repo'} isn’t on GitHub.</p>`;
      let detail;
      if (draft.source === 'github' && off) detail = why;
      else if (draft.source === 'none') detail = '<p class="muted small">Every task is numbered T-1, T-2… on this board, with no ticket. Its badge reads Task.</p>';
      else if (draft.source === 'github') detail = `<div class="who tk-static"><span>Issues in ${esc(repo())}<span class="muted small sub">${isNew ? 'The repo chosen above' : 'The board’s repo, set above'}. A task opens an issue there${draft.account ? ` as gh account ${esc(draft.account)}` : ''} when it goes ready to build; its badge then reads #41.</span></span></div>`;
      else detail = linearDetail();
      root.innerHTML = `${status()}${segment}<div class="tk-detail">${noGithub && off && draft.source !== 'github' ? why : ''}${detail}</div>`;
      if (draft.source === 'linear' && ready()) {
        root.querySelector('[data-tk="team"]').value = draft.team || '';
        root.querySelector('[data-tk="project"]').value = draft.project || '';
      }
    }
    // Linear is checked again on each tap until Hub's key works, so a key added elsewhere counts.
    async function pickLinear() {
      if (asking || linear?.loading) return;
      const before = draft.source;
      draft.source = 'linear';
      if (!ready()) await load();
      if (destroyed) return;
      if (!works()) {
        draft.source = before;
        render();
        asking = true;
        const added = await LinearKey.open();
        asking = false;
        if (destroyed || !added) return;
        if (keyState) key = await keyState().catch(() => key);
        if (destroyed) return;
        draft.source = 'linear';
        await load();
        if (destroyed) return;
      }
      pickDefaults();
      render(); root.querySelector('[data-tk-source="linear"]').focus(); change(read(), valid());
    }
    const click = async (e) => {
      if (e.target.closest('[data-tk-create]')) {
        const name = newName();
        if (!name || creating || !createProject) return;
        creating = true; createError = ''; render();
        try {
          const made = await createProject(draft.team, name);
          const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
          linear.projects = [...(linear.projects || []), made].sort((a, b) => byName.compare(a.name, b.name));
          draft.project = made.id;
          delete draft.newName;
        } catch (error) { createError = error.message || 'Could not create the project.'; }
        creating = false;
        render(); change(read(), valid());
        return;
      }
      if (e.target.closest('[data-tk-key]')) { pickLinear(); return; }
      const button = e.target.closest('[data-tk-source]');
      if (!button) return;
      noGithub = button.dataset.tkSource === 'github' && !repo();
      if (noGithub) { render(); root.querySelector('[data-tk-source="github"]').focus(); return; }
      if (button.dataset.tkSource === 'linear') { pickLinear(); return; }
      draft.source = button.dataset.tkSource;
      render(); root.querySelector(`[data-tk-source="${draft.source}"]`).focus(); change(read(), valid());
    };
    const input = (e) => {
      const field = e.target.dataset.tk;
      if (!field || (e.type === 'input' && e.target.tagName === 'SELECT')) return;
      draft[field] = e.target.value;
      if (field === 'team') draft.project = isNew ? '__new' : linear.projects?.find((p) => p.team === draft.team)?.id;
      if (field === 'team' || field === 'project') { createError = ''; render(); }
      change(read(), valid(), { typing: e.type === 'input' });
    };
    root.addEventListener('click', click);
    root.addEventListener('input', input);
    root.addEventListener('change', input);
    render();
    if (draft.source === 'linear' && !linear) load().then(() => { if (destroyed) return; pickDefaults(); render(); change(read(), valid(), { loaded: true }); });
    // Without an answer the row has no status word.
    if (keyState) keyState().then((state) => { if (destroyed) return; key = state; render(); }, () => {});
    return { read, valid, render, nameChanged() {
        const field = root.querySelector('[data-tk="newName"]');
        if (field && draft.newName === undefined) field.value = title();
      },
      destroy() { destroyed = true; root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', input); } };
  }
  function fitSheet(sheet) {
    const vv = window.visualViewport;
    // iOS keeps fixed elements on the layout viewport; --kb is the part covered by its keyboard.
    // --sheet-full is the tallest the viewport has been while the sheet is open, so the pan (offsetTop) when a field
    // takes focus doesn't lower the sheet's top; turning the phone measures it again.
    let full = 0, width = window.innerWidth;
    const fit = () => {
      const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      if (window.innerWidth !== width) { width = window.innerWidth; full = 0; }
      full = Math.max(full, (vv ? vv.height : window.innerHeight) + kb);
      sheet.style.setProperty('--kb', kb + 'px');
      sheet.style.setProperty('--sheet-full', full + 'px');
      sheet.style.setProperty('--vh', (vv ? vv.height : window.innerHeight) + 'px');
      sheet.classList.toggle('kb', kb > 0);
    };
    // iOS scrolls the page to show a focused field even under a modal sheet, and then draws the sheet cut off above the
    // keyboard with the board below it, so the page keeps its scroll position. innerHeight reads short during that
    // scroll and no resize follows the restore, so --kb is measured again once the keyboard has settled.
    let y = window.scrollY;
    let settle = 0;
    const pin = () => {
      // The 900px breakpoint must match style.css's html:has(dialog:modal) scroll lock.
      if (matchMedia('(min-width: 900px)').matches) { y = window.scrollY; return; }
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
    // A file picker closing returns focus to the window without a resize, so the sheet is measured again.
    window.addEventListener('focus', fit);
    window.addEventListener('scroll', pin);
    return () => {
      clearTimeout(settle);
      vv?.removeEventListener('resize', fit);
      vv?.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
      window.removeEventListener('focus', fit);
      window.removeEventListener('scroll', pin);
    };
  }
  // New (no current) opens on a Board | Course switch when course is given: Board picks a repo and posts through save,
  // Course takes a name and what to learn and posts through course
  // (docs/adr/2026-11-18-0600-new-starts-a-board-or-a-teach-course.md). With current it is Change repo. New's Board
  // picks its repo's source first: GitHub, Other git host, or Folder on this Mac, a folder the board works in place
  // (docs/adr/2026-11-18-0724-a-new-board-can-anchor-on-a-folder-on-this-mac.md).
  function repoSheet({ current, save, course, onClose = () => {} }) {
    if (document.getElementById('newBoardSheet')) return () => {};
    const previous = document.activeElement;
    const el = document.createElement('dialog');
    el.setAttribute('id', 'newBoardSheet');
    el.setAttribute('class', 'sheet');
    el.setAttribute('aria-labelledby', 'newBoardTitle');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // draft.folder is the chosen folder's path, else ''; place is what the hub found there (hub/folders.mjs folderInfo).
    const draft = { name: '', purpose: '', github: '', remote: '', folder: '', branch: '', tickets: { source: 'none' } };
    const courseDraft = { name: '', learn: '' };
    let kind = 'board', source = 'github', typedFolder = '', place = null, gitInit = false;
    let tickets;
    let repos = [], signedIn = false, pasted, selected, edited = false, sending = false, closed = false, generation = 0, lookupTimer, linear;
    const controller = new AbortController();
    el.innerHTML = `<form class="nb-form"><div class="sheet-head"><h2 id="newBoardTitle" tabindex="-1" autofocus>${current ? 'Change repo' : 'New'}</h2><button type="button" data-cancel-new aria-label="Close sheet">✕</button></div>${course && !current ? '<div class="segments nb-kind" role="group" aria-label="What to make"><button type="button" data-nb-kind="board" aria-pressed="true">Board</button><button type="button" data-nb-kind="course" aria-pressed="false">Course</button></div>' : ''}<div data-repo-content></div><p class="nb-error" role="alert" hidden></p><div class="nb-actions sheet-actions"><button type="button" data-cancel-new>Cancel</button><button type="button" class="primary" data-folder-next hidden disabled>Next</button><button type="submit" class="primary" hidden disabled>${current ? 'Use repo' : 'Start'}</button></div></form>`;
    const content = el.querySelector('[data-repo-content]');
    const form = el.querySelector('form');
    const start = el.querySelector('[type="submit"]');
    const next = el.querySelector('[data-folder-next]');
    const error = el.querySelector('[role="alert"]');
    const field = (name) => el.querySelector(`[name="${name}"]`);
    const request = async (url, options = {}) => {
      const r = await fetch(url, { ...options, signal: controller.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load repos. Try again.');
      return d;
    };
    const fail = (e) => { if (!closed) { error.textContent = e.message; error.hidden = false; } };
    // New's repo sources, above step 1's field.
    const sources = () => (current ? '' : `<div class="segments nb-source" role="group" aria-label="Repo source">${[['github', 'GitHub'], ['git', 'Other git host'], ['folder', 'Folder on this Mac']].map(([value, label]) => `<button type="button" data-nb-source="${value}" aria-pressed="${source === value}">${label}</button>`).join('')}</div>`);
    // A course's route as the hub makes it from the name (hub/routes.mjs routeFromName).
    const courseRoute = () => courseDraft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41).replace(/-+$/, '');
    const routeHelp = () => (courseRoute() ? `Opens at /${esc(courseRoute())}/` : 'Letters and digits make its address.');
    function sync() {
      if (kind === 'course') { start.disabled = sending || !courseRoute() || !courseDraft.learn.trim(); return; }
      next.disabled = !place || !(place.git || gitInit);
      start.disabled = sending || !(draft.github || draft.remote || draft.folder) || !draft.branch || (!current && (!draft.name.trim() || !draft.purpose.trim() || !tickets?.valid()));
    }
    // A repo row's id is its GitHub owner/name, or the git link of a repo on another host, which the row names by
    // host/path and labels with its host where a GitHub row says Private or Public
    // (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
    const idOf = (r) => r.github || r.remote;
    const nameOf = (r) => r.github || r.name;
    const access = (r) => (r.remote ? r.host : r.private ? 'Private' : 'Public');
    const row = (r, highlighted = false) => `<button type="button" class="nb-repo${highlighted ? ' nb-repo-highlight' : ''}" data-repo="${esc(idOf(r))}"><strong>${esc(nameOf(r))}</strong>${r.listed === false ? '<span class="nb-repo-tag">Not in your list</span>' : ''}<span class="nb-help">${esc(access(r))} · <time datetime="${esc(r.pushedAt)}">${r.pushedAt ? `Pushed ${esc(new Date(r.pushedAt).toLocaleString())}` : r.listed === false ? 'Last push unknown' : 'No pushes yet'}</time></span><span class="nb-help">${esc(r.description)}</span><span class="nb-local">${r.cloned ? `✓ Cloned${r.shared.length ? ` · shared with ${esc(r.shared.map((b) => b.title).join(', '))}` : ' · already cloned'}` : 'Not cloned yet'}</span></button>`;
    const results = (html) => { el.querySelector('[data-repo-results]').innerHTML = html; };
    function rows(query = '') {
      if (!signedIn) { results(''); return; }
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
      const checking = (name) => results(`<p class="nb-help" role="status">Checking the hub can reach it…</p><div class="nb-box"><span class="nb-spin" aria-hidden="true"></span><span><strong>${esc(name)}</strong><span class="nb-help">Checking…</span></span></div>`);
      const check = (query, name) => async () => {
        try {
          const repo = await request(`/_hub/repo?${query}`);
          if (closed || generation !== version) return;
          pasted = repo;
          results(`<p class="nb-help" role="status">From your link</p><div class="nb-repo-list">${row(repo)}</div>`);
        } catch (e) { if (!closed && generation === version) reason(name, e.message); }
      };
      if (/^(?:file:|[/~]|\.\.?\/)/i.test(q)) { reason(q, current ? 'Paste the repo’s remote link. Local folders don’t work here.' : 'That’s a folder. Pick Folder on this Mac above.'); return; }
      if (host && !/^(?:www\.)?github\.com$/i.test(host[1])) {
        const name = q.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/^[^@/\s]+@/, '').replace(/:(?!\d+\/)/, '/').replace(/:\d+\//, '/').replace(/\.git\/?$/i, '');
        checking(name);
        check(`remote=${encodeURIComponent(q)}`, name)();
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
      checking(github);
      if (bare) lookupTimer = setTimeout(check(`github=${encodeURIComponent(github)}`, github), 500);
      else check(`github=${encodeURIComponent(github)}`, github)();
    }
    function coursePane() {
      tickets?.destroy();
      tickets = null;
      ++generation;
      clearTimeout(lookupTimer);
      selected = null;
      error.hidden = true;
      content.innerHTML = `<label class="nb-field"><span>Name (becomes the route)</span><input name="course-name" type="text" value="${esc(courseDraft.name)}" required maxlength="60" autocomplete="off"><span class="nb-help" data-course-route>${routeHelp()}</span></label>`
        + `<label class="nb-field"><span>What do you want to learn?</span><textarea name="learn" rows="3" required maxlength="1000">${esc(courseDraft.learn)}</textarea><span class="nb-help">Start runs /teach and writes lesson 1.</span></label>`;
      next.hidden = true;
      start.hidden = false;
      sync();
    }
    function switchKind(value) {
      if (value === kind) return;
      kind = value;
      el.querySelectorAll('[data-nb-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nbKind === kind)));
      if (kind === 'course') coursePane(); else picker();
    }
    const linkField = (label) => `<label class="nb-field"><span>${label}</span><input name="search" type="search" placeholder="https://host/path or user@host:path" autocomplete="off" autocapitalize="off" spellcheck="false"></label><div data-repo-results></div>`;
    async function picker(fresh = false) {
      tickets?.destroy();
      tickets = null;
      const version = ++generation;
      clearTimeout(lookupTimer);
      pasted = null;
      selected = null;
      start.hidden = true;
      next.hidden = true;
      error.hidden = true;
      if (source === 'folder') { folderPane(); return; }
      const head = `<p class="nb-next">1 · Choose a repo</p>${sources()}`;
      if (source === 'git') {
        signedIn = false;
        content.innerHTML = `${head}${linkField('Paste a git link')}`;
        return;
      }
      content.innerHTML = `${head}<p role="status">Loading repos…</p>`;
      try {
        const d = await request(`/_hub/repos${fresh ? '?fresh=1' : ''}`);
        if (closed || generation !== version) return;
        signedIn = d.signedIn;
        if (!d.signedIn) {
          repos = [];
          content.innerHTML = `${sources()}<h3>GitHub isn’t connected</h3><p>gh isn’t signed in on the host running Kickflip. Sign in there to see your repos.</p><code>gh auth login</code><p><button type="button" data-check-auth>Check again</button></p>${linkField('Or paste a git link')}`;
          return;
        }
        repos = d.repos;
        content.innerHTML = `${head}<p>Choose the repo this board will work on: one of your GitHub repos, or any git repo by its link.</p><label class="nb-field"><span>Search repos or paste a git link</span><input name="search" type="search" placeholder="Search or paste owner/name or a git link…" autocomplete="off" autocapitalize="off" spellcheck="false"></label><div data-repo-results></div>`;
        rows();
      } catch (e) { if (generation === version) { fail(e); content.innerHTML = `${sources()}<button type="button" data-check-auth>Try again</button>`; } }
    }
    // What the hub found at the folder, as one dot line: green a repo with an origin, blue a repo that won't push, orange
    // not a repo yet, red refused (AGENTS.md colour priority).
    const dotLine = (colour, text) => BoardUI.iconText('dot', colour, text);
    const foundLine = (found) => (found.github ? dotLine('green', `Git repo · github.com/${found.github} · ${found.branch}`)
      : found.remote ? dotLine('green', `Git repo · ${found.remote} · ${found.branch}`)
        : found.git ? dotLine('blue', 'Git repo · no remote · lands won’t push')
          : gitInit ? dotLine('blue', 'Will be a git repo · no remote · lands won’t push') : dotLine('orange', 'Not a git repo'));
    const initToggle = () => `<label class="nb-box nb-init"><span><strong>Make it a git repo</strong><span class="nb-help">git init, and commit what’s there as the first commit. Applies when you tap Start.</span></span><input type="checkbox" class="toggle" name="git-init"${gitInit ? ' checked' : ''}></label>`;
    // Step 1 for a folder: a path field, the folders under it as you type, and what the hub found at the path typed.
    function folderPane() {
      content.innerHTML = `<p class="nb-next">1 · Choose a repo</p>${sources()}<label class="nb-field"><span>Folder on this Mac</span><input name="folder-path" type="text" value="${esc(typedFolder)}" placeholder="~/dev/…" autocomplete="off" autocapitalize="off" spellcheck="false"></label><div data-folder-results></div>`;
      next.hidden = false;
      lookFolder(typedFolder, 0);
    }
    // Looks the typed path up after wait ms: the folders under it (/_hub/folders) and, unless it ends in a slash, what is
    // there (/_hub/folder). A newer keystroke drops an older answer.
    function lookFolder(value, wait = 250) {
      const version = ++generation;
      clearTimeout(lookupTimer);
      place = null;
      sync();
      const show = (html) => { el.querySelector('[data-folder-results]').innerHTML = html; };
      if (!value.trim()) { show('<p class="nb-help">Start typing a path under ~ and tap a folder.</p>'); return; }
      lookupTimer = setTimeout(async () => {
        const answer = (url) => fetch(url, { signal: controller.signal }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json() }));
        let list, found;
        try {
          [list, found] = await Promise.all([answer(`/_hub/folders?q=${encodeURIComponent(value)}`), value.trim().endsWith('/') ? null : answer(`/_hub/folder?path=${encodeURIComponent(value)}`)]);
        } catch (e) { if (!closed && generation === version) show(`<p class="nb-found" role="status">${dotLine('red', e.message)}</p>`); return; }
        if (closed || generation !== version) return;
        if (found?.ok) place = found.body;
        const folders = (list.body.folders || []).filter((f) => f !== place?.folder);
        const line = place ? `<p class="nb-found" role="status" data-folder-line>${foundLine(place)}</p>${place.git ? '' : initToggle()}`
          : found && found.status !== 404 ? `<p class="nb-found" role="status">${dotLine('red', found.body.error)}</p>`
            : folders.length ? '' : '<p class="nb-help">No folder there. Keep typing, or tap a suggestion.</p>';
        show(`${line}${folders.length ? `<div class="nb-repo-list" aria-label="Folders under ~">${folders.map((f) => `<button type="button" class="nb-repo" data-folder="${esc(f)}"><strong>${esc(f)}</strong></button>`).join('')}</div>` : ''}`);
        sync();
      }, wait);
    }
    // Step 2 for a folder: its line, its branch (main for a folder git init makes a repo), and the board's details.
    function folderDetails() {
      ++generation;
      clearTimeout(lookupTimer);
      Object.assign(draft, { github: place.github || '', remote: '', folder: place.path, branch: place.branch });
      selected = { clone: place.path, cloned: true };
      if (!edited) draft.name = place.folder.split('/').at(-1);
      next.hidden = true;
      error.hidden = true;
      const lands = place.github || place.remote ? `lands fast-forward ${place.branch} in this folder` : `lands fast-forward ${place.branch} and never push`;
      content.innerHTML = `<button type="button" data-back-repos>‹ Back</button><p class="nb-next">2 · Board details</p><div class="nb-selected"><strong>${esc(place.folder)}</strong><span class="nb-help">${foundLine(place)}</span></div><label class="nb-field"><span>Default branch for this board</span><select name="branch"${place.git ? '' : ' disabled'}>${place.branches.map((b) => `<option value="${esc(b)}"${b === draft.branch ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select><span class="nb-help" data-branch-help>${place.git ? `Read from the folder. New implementers branch from ${esc(draft.branch)}.` : 'A new repo starts on main.'}</span></label>${detailFields()}<p class="nb-next">On this board, ${lands}. Implementers work in worktrees off this folder.</p>`;
      mountTickets();
      start.hidden = false;
      sync();
    }
    const detailFields = () => `<label class="nb-field"><span>Name</span><input name="name" type="text" value="${esc(draft.name)}" required maxlength="60" autocomplete="off"></label><label class="nb-field"><span>Description</span><input name="purpose" type="text" value="${esc(draft.purpose)}" required maxlength="240" autocomplete="off"><span class="nb-help">Used by the hub for request routing</span></label>`;
    // The Tickets control, above the last of the details' notes.
    function mountTickets() {
      content.querySelectorAll('.nb-next')[content.querySelectorAll('.nb-next').length - 1].insertAdjacentHTML('beforebegin', '<div class="nb-field tk-section" role="group" aria-labelledby="nbTicketsLabel"><span id="nbTicketsLabel">Tickets</span><span class="nb-help">Where this board’s tasks get their tickets. You can change it in Board settings.</span><div data-board-tickets></div></div>');
      tickets = ticketsControl(content.querySelector('[data-board-tickets]'), { value: draft.tickets, linear, loadLinear: async () => (linear = await request('/_hub/api/linear')),
        repo: () => draft.github, title: () => draft.name.trim(), isNew: true, change(value) { draft.tickets = value; sync(); } });
    }
    async function pick(id) {
      selected = repos.find((r) => r.github === id) || (pasted && idOf(pasted) === id ? pasted : null);
      if (!selected) return;
      const version = ++generation;
      clearTimeout(lookupTimer);
      draft.github = selected.github || '';
      draft.remote = selected.remote || '';
      draft.folder = '';
      draft.branch = '';
      if (!edited) draft.name = nameOf(selected).split('/').at(-1);
      error.hidden = true;
      const shared = selected.shared.map((b) => b.title).join(', ');
      content.innerHTML = `<button type="button" data-back-repos>‹ Back</button><p class="nb-next">${current ? 'Repo details' : '2 · Board details'}</p><div class="nb-selected"><strong>${esc(nameOf(selected))}</strong><span class="nb-help">${esc(access(selected))}</span><p>${selected.cloned ? shared ? `Shared with ${esc(shared)}` : 'Already cloned' : 'Clones to'}<code class="nb-clone">${esc(selected.clone)}</code></p></div><label class="nb-field"><span>Default branch for this board</span><select name="branch" disabled><option value="">Loading branches…</option></select><span class="nb-help" data-branch-help></span></label><p class="nb-next">Each board’s implementers work in separate worktrees off this clone. Sharing the clone doesn’t share their working files.</p>${current ? '<p class="nb-next">New implementers and GitHub links will use the selected repo.</p>' : `${detailFields()}<p class="nb-next">The hub ${selected.cloned ? 'reuses the clone' : 'clones the repo'} and starts your board. You can keep using your other boards.</p>`}`;
      if (!current) mountTickets();
      start.hidden = false;
      sync();
      try {
        const d = await request(`/_hub/branches?${draft.remote ? 'remote' : 'github'}=${encodeURIComponent(id)}`);
        if (closed || generation !== version) return;
        draft.branch = (current?.github || current?.remote) === id && d.branches.includes(current.branch) ? current.branch : d.defaultBranch;
        if (!d.branches.includes(draft.branch)) draft.branch = d.branches[0] || '';
        field('branch').innerHTML = d.branches.map((b) => `<option value="${esc(b)}"${b === draft.branch ? ' selected' : ''}>${esc(b)}${b === d.defaultBranch ? ' (repo default)' : ''}</option>`).join('');
        field('branch').value = draft.branch;
        field('branch').disabled = false;
        el.querySelector('[data-branch-help]').textContent = draft.branch ? `New implementers branch from ${draft.branch}.` : 'This repo has no branches yet.';
        sync();
      } catch (e) { fail(e); }
    }
    const done = () => { if (!sending) el.close(); };
    form.addEventListener('click', (e) => {
      if (sending) return;
      if (e.target.closest('[data-cancel-new]')) done();
      else if (e.target.closest('[data-nb-kind]')) switchKind(e.target.closest('[data-nb-kind]').dataset.nbKind);
      else if (e.target.closest('[data-nb-source]')) { source = e.target.closest('[data-nb-source]').dataset.nbSource; picker(); }
      else if (e.target.closest('[data-folder]')) {
        typedFolder = e.target.closest('[data-folder]').dataset.folder;
        gitInit = false;
        field('folder-path').value = typedFolder;
        lookFolder(typedFolder, 0);
      } else if (e.target.closest('[data-folder-next]')) { if (!next.disabled) folderDetails(); }
      else if (e.target.closest('[data-check-auth]')) picker(true);
      else if (e.target.closest('[data-back-repos]')) picker();
      else { const row = e.target.closest('[data-repo]'); if (row) pick(row.dataset.repo); }
    });
    form.addEventListener('input', (e) => {
      if (e.target.getAttribute('name') === 'search') { search(e.target.value); return; }
      if (e.target.getAttribute('name') === 'folder-path') { typedFolder = e.target.value; gitInit = false; lookFolder(typedFolder); return; }
      if (e.target.getAttribute('name') === 'name') { draft.name = e.target.value; edited = true; tickets?.nameChanged(); }
      if (e.target.getAttribute('name') === 'purpose') draft.purpose = e.target.value;
      if (e.target.getAttribute('name') === 'course-name') { courseDraft.name = e.target.value; el.querySelector('[data-course-route]').innerHTML = routeHelp(); }
      if (e.target.getAttribute('name') === 'learn') courseDraft.learn = e.target.value;
      sync();
    });
    form.addEventListener('change', (e) => {
      if (e.target.getAttribute('name') === 'git-init') {
        gitInit = e.target.checked;
        el.querySelector('[data-folder-line]').innerHTML = foundLine(place);
        sync();
      }
      if (e.target.getAttribute('name') === 'branch') {
        draft.branch = e.target.value;
        el.querySelector('[data-branch-help]').textContent = `New implementers branch from ${draft.branch}.`;
        sync();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (sending || start.disabled || (kind === 'board' && !selected)) return;
      sending = true;
      sync();
      error.hidden = true;
      try {
        if (kind === 'course') {
          await BoardUI.waitOn(start, course({ name: courseDraft.name.trim(), learn: courseDraft.learn.trim() }));
          sending = false;
          el.close();
          return;
        }
        const repo = draft.folder ? { folder: draft.folder, ...(place.git ? {} : { git_init: true }) } : draft.remote ? { remote: draft.remote } : { github: draft.github };
        // Start, or Use repo, waits (ui.js waitOn) until the hub answers; a new board's own start then shows in the sidebar.
        await BoardUI.waitOn(start, save(current ? { ...repo, branch: draft.branch } : { name: draft.name.trim(), purpose: draft.purpose.trim(), ...repo, branch: draft.branch, tickets: tickets.read() }, selected));
        sending = false;
        el.close();
      } catch (e) { sending = false; fail(e); sync(); }
    });
    el.addEventListener('cancel', (e) => { e.preventDefault(); done(); });
    el.addEventListener('click', (e) => { if (BoardUI.onBackdrop(e, el)) done(); });
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
    BoardUI.swipeToDismiss(el);
    el.showModal();
    el.querySelector('h2').focus({ preventScroll: true });
    picker();
    return () => { sending = false; el.close(); };
  }
  const confirm = (message, { signal } = {}) => Promise.resolve(!signal?.aborted && window.confirm(message));
  const notice = (message) => { window.alert(message); return Promise.resolve(); };
  globalThis.BoardDialogs = { confirm, notice, fitSheet, repoSheet, ticketsControl };
})();
