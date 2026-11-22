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
  // Focuses a sheet's field without the page scrolling, then scrolls the field into view once the keyboard is up: on the
  // viewport's next resize, or after 400ms when the keyboard was already up and no resize comes. Once. Returns the cancel,
  // for a view that unmounts first.
  function focusField(field) {
    field.focus({ preventScroll: true });
    const vv = window.visualViewport;
    let timer;
    const cancel = () => { clearTimeout(timer); vv?.removeEventListener('resize', reveal); };
    const reveal = () => { cancel(); field.scrollIntoView({ block: 'nearest' }); };
    vv?.addEventListener('resize', reveal);
    timer = setTimeout(reveal, 400);
    return cancel;
  }
  // docs/adr/2026-11-21-2300-new-board-and-new-course-share-one-source-field.md
  // New's one source field: Board's step 1, Course's optional "Learn from…" and Change repo's repo. It takes a GitHub
  // repo (listed, a link or owner/name), another git remote, or a folder on this Mac, its kind read from what is typed,
  // and empty it suggests by kind: Your repos, Other remotes, Folders on this Mac. use is board, course or change
  // (Change repo, which takes no folder). list() is the hub's /_hub/repos answer ({signedIn, repos, recent}), null while
  // it loads; reload() asks for it again. request fetches the hub's JSON. The sheet's form hands its events to handle(e),
  // and change() follows each change of state(): {status, repo?, place?, gitInit}, status empty (nothing typed), typing
  // (text that names no source yet), checking, ok, init (a folder that isn't a git repo, until Make it a git repo) or bad.
  // A board's repo row id is its GitHub owner/name, or the git link of a repo on another host, which the row names by
  // host/path and labels with its host where a GitHub row says Private or Public
  // (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
  const idOf = (r) => r.github || r.remote;
  const nameOf = (r) => r.github || r.name;
  const access = (r) => (r.remote ? r.host : r.private ? 'Private' : 'Public');
  function sourceField(root, { use, value = '', list, reload, request, signal, change = () => {} }) {
    const { esc } = BoardUI;
    let typed = value, status = 'empty', repo = null, place = null, gitInit = false, version = 0, timer;
    const label = use === 'course' ? 'Learn from… <span class="nb-optional">Optional</span>' : use === 'change' ? 'Repo' : 'Source';
    root.innerHTML = `<label class="nb-field nb-source"><span>${label}</span><input name="source" type="search" value="${esc(typed)}" placeholder="${use === 'change' ? 'Paste a link or owner/name' : 'Paste a link, owner/name or a path'}" autocomplete="off" autocapitalize="off" spellcheck="false"></label><div data-source-line></div><div data-source-list></div>`;
    const input = root.querySelector('[name="source"]');
    const show = (line, rows = '') => {
      root.querySelector('[data-source-line]').innerHTML = line;
      root.querySelector('[data-source-list]').innerHTML = rows;
      input.classList.toggle('nb-bad', status === 'bad');
    };
    const set = (next) => { status = next; change(state()); };
    const state = () => ({ status, typed, gitInit, ...(repo ? { repo } : {}), ...(place ? { place } : {}) });
    // One line under the field, a dot in the colour of what it says (AGENTS.md colour priority).
    const line = (colour, html, role = 'status') => `<p class="nb-line nb-line-${colour}" role="${role}">${BoardUI.iconText('dot', colour, '')}<span>${html}</span></p>`;
    const bad = (why) => line('red', esc(why), 'alert');
    const okLine = (name, tag, note, meaning) => line('green', `<strong>${esc(name)}</strong><span class="nb-repo-tag">${tag}</span> · ${esc(note)}<small>${esc(meaning)}</small>`);
    const repoRow = (r) => `<button type="button" class="nb-repo" data-repo="${esc(idOf(r))}"><strong>${esc(nameOf(r))}</strong><span class="nb-help">${esc(access(r))} · <time datetime="${esc(r.pushedAt)}">${r.pushedAt ? `Pushed ${esc(new Date(r.pushedAt).toLocaleString())}` : 'No pushes yet'}</time></span><span class="nb-help">${esc(r.description)}</span><span class="nb-local">${r.cloned ? `✓ Cloned${r.shared.length ? ` · shared with ${esc(r.shared.map((b) => b.title).join(', '))}` : ' · already cloned'}` : 'Not cloned yet'}</span></button>`;
    const pickRow = (value, name, note) => `<button type="button" class="nb-repo" data-source-pick="${esc(value)}"><strong>${esc(name)}</strong>${note ? `<span class="nb-help">${esc(note)}</span>` : ''}</button>`;
    const group = (title, body) => `<div class="nb-group"><h4>${title}</h4>${body}</div>`;
    const repos = () => list()?.repos || [];
    const matches = (q) => (r) => `${r.github} ${r.description}`.toLowerCase().includes(q.toLowerCase());
    // The suggestions by kind, those matching q.
    function suggestions(q) {
      const answer = list();
      const own = !answer ? '<p class="nb-help" role="status">Loading your repos…</p>'
        : !answer.signedIn ? '<p class="nb-help">GitHub isn’t connected: gh isn’t signed in on the host running Kickflip. Sign in there to see your repos.</p><code>gh auth login</code><p><button type="button" data-check-auth>Check again</button></p>'
          : ((found) => `<p class="nb-help" role="status">${found.length} of ${answer.repos.length} repos · Newest push first</p><div class="nb-repo-list">${found.map(repoRow).join('')}</div>${found.length ? '' : '<p class="nb-help">No matching repos. Try an owner or repo name.</p>'}`)(answer.repos.filter(matches(q)));
      const used = (by) => `Used by ${by.join(', ')}`;
      const remotes = (answer?.recent?.remotes || []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));
      // Board can't anchor on another board's folder, so it suggests only the folders courses read.
      const folders = use === 'change' ? [] : (answer?.recent?.folders || []).filter((f) => !(use === 'board' && f.board) && f.folder.toLowerCase().includes(q.toLowerCase()));
      return group('Your repos', own)
        + (remotes.length ? group('Other remotes', `<div class="nb-repo-list">${remotes.map((r) => pickRow(r.remote, r.name, used(r.by))).join('')}</div>`) : '')
        + (use === 'change' ? '' : group('Folders on this Mac', `${folders.length ? `<div class="nb-repo-list">${folders.map((f) => pickRow(f.folder, f.folder, used(f.by))).join('')}</div>` : ''}<p class="nb-help">Or type a folder’s path, such as ~/dev/…</p>`));
    }
    const emptyLine = () => (use === 'course' ? '<p class="nb-help">A repo or folder for /teach to read. Lessons stay in the course’s pages folder; leave it empty to learn a topic.</p>'
      : line('grey', use === 'change' ? 'No repo yet: pick one of yours, or paste a link.' : 'No source yet: pick a repo, a remote or a folder.'));
    function chosen(r) {
      repo = r;
      const name = nameOf(r);
      const where = r.cloned ? `cloned${r.shared.length ? ` · shared with ${r.shared.map((b) => b.title).join(', ')}` : ''}` : 'not cloned yet';
      const note = `${access(r)}${r.listed === false ? ' · not in your list' : ''} · ${where}`;
      const meaning = use === 'course' ? `/teach reads ${name} (cloned into the shared clone home to be read); lessons stay in the course’s pages folder.`
        : use === 'change' ? `New implementers and GitHub links will use ${name}.`
          : r.cloned ? `Board works on ${name}: already cloned in the shared clone home.` : `Board clones ${name} into the shared clone home.`;
      set('ok');
      show(okLine(name, r.remote ? 'Git remote' : 'GitHub repo', note, meaning));
    }
    // What the hub found at a folder, for a board: green a repo with an origin, blue a repo that won't push, orange not a
    // repo yet (AGENTS.md colour priority).
    const found = () => (place.github ? ['green', `Git repo · github.com/${place.github} · ${place.branch}`]
      : place.remote ? ['green', `Git repo · ${place.remote} · ${place.branch}`]
        : place.git ? ['blue', 'Git repo · no remote · lands won’t push']
          : gitInit ? ['blue', 'Will be a git repo · no remote · lands won’t push'] : ['orange', 'Not a git repo']);
    const initToggle = () => `<label class="nb-box nb-init"><span><strong>Make it a git repo</strong><span class="nb-help">git init, and commit what’s there as the first commit. Applies when you tap Start.</span></span><input type="checkbox" class="toggle" name="git-init"${gitInit ? ' checked' : ''}></label>`;
    function folderLine() {
      if (use === 'course') return okLine(place.folder, 'Folder', place.git ? 'git repo' : 'plain folder', `/teach reads ${place.folder}; lessons are written to the course’s pages folder.`);
      const [colour, text] = found();
      const meaning = `Board joins ${place.folder} in place: no clone, nothing copied.`;
      return `${line(colour, `<strong>${esc(place.folder)}</strong><span class="nb-repo-tag">Folder</span> · <span data-folder-line>${esc(text)}</span>${place.git || gitInit ? `<small>${esc(meaning)}</small>` : ''}`)}${place.git ? '' : initToggle()}`;
    }
    // Looks a typed path up after wait ms: the folders under it (/_hub/folders) and, unless it ends in a slash, what is
    // there (/_hub/folder, with read=1 for a course, which reads any folder). A newer keystroke drops an older answer.
    function lookFolder(q, mine, wait) {
      set('typing');
      show('', '');
      timer = setTimeout(async () => {
        const answer = (url) => fetch(url, { signal }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json() }));
        let folders, at;
        try {
          [folders, at] = await Promise.all([answer(`/_hub/folders?q=${encodeURIComponent(q)}`), q.endsWith('/') ? null : answer(`/_hub/folder?path=${encodeURIComponent(q)}${use === 'course' ? '&read=1' : ''}`)]);
        } catch (e) { if (mine === version && !signal?.aborted) { set('bad'); show(bad(e.message)); } return; }
        if (mine !== version) return;
        const under = (folders.body.folders || []).filter((f) => f !== at?.body?.folder);
        const rows = under.length ? group('Folders on this Mac', `<div class="nb-repo-list" aria-label="Folders under ~">${under.map((f) => pickRow(f, f)).join('')}</div>`) : '';
        if (at?.ok) { place = at.body; set(place.git || use === 'course' ? 'ok' : 'init'); show(folderLine(), rows); return; }
        if (at && at.status !== 404) { set('bad'); show(bad(at.body.error), rows); return; }
        show(under.length ? '' : '<p class="nb-help">No folder there. Keep typing, or tap a suggestion.</p>', rows);
      }, wait);
    }
    // Asks the hub whether it can reach a pasted repo, after wait ms.
    function lookRepo(query, name, mine, wait) {
      set('checking');
      show(`<p class="nb-line" role="status"><span class="nb-spin" aria-hidden="true"></span><span>Checking the hub can reach <strong>${esc(name)}</strong>…</span></p>`);
      const ask = async () => {
        try {
          const r = await request(`/_hub/repo?${query}`);
          if (mine === version) chosen(r);
        } catch (e) { if (mine === version && !signal?.aborted) { set('bad'); show(bad(`Can’t reach ${name}: ${e.message}`)); } }
      };
      if (wait) timer = setTimeout(ask, wait); else ask();
    }
    function search(text, { now = false } = {}) {
      const mine = ++version;
      clearTimeout(timer);
      typed = text;
      repo = null; place = null; gitInit = false;
      const q = text.trim();
      if (!q) { set('empty'); show(emptyLine(), suggestions('')); return; }
      if (/^(?:file:|[/~]|\.\.?\/)/i.test(q)) {
        if (use === 'change') { set('bad'); show(bad('Paste the repo’s remote link. Local folders don’t work here.')); return; }
        lookFolder(q, mine, now ? 0 : 250);
        return;
      }
      const host = /^(?:[a-z][a-z\d+.-]*:\/\/(?:[^@/\s]+@)?|[^@/\s]+@)([^/:?#\s]+)/i.exec(q);
      if (host && !/^(?:www\.)?github\.com$/i.test(host[1])) {
        const name = q.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/^[^@/\s]+@/, '').replace(/:(?!\d+\/)/, '/').replace(/:\d+\//, '/').replace(/\.git\/?$/i, '');
        lookRepo(`remote=${encodeURIComponent(q)}`, name, mine, 0);
        return;
      }
      const link = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s?#]+\/[^/\s?#]+)(?:\/[^\s]*)?(?:[?#][^\s]*)?$/i.exec(q);
      const bare = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(q);
      if (host && !link) { set('bad'); show(bad('That link doesn’t name a repo. Use github.com/owner/name.')); return; }
      if (!link && !bare) { set('typing'); show('', suggestions(q)); return; }
      const github = link ? link[1].replace(/\.git$/i, '') : q;
      const listed = repos().find((r) => r.github.toLowerCase() === github.toLowerCase());
      if (listed) { chosen(listed); return; }
      if (bare && repos().some(matches(q))) { set('typing'); show('', suggestions(q)); return; }
      lookRepo(`github=${encodeURIComponent(github)}`, github, mine, bare ? 500 : 0);
    }
    const fill = (text) => { input.value = text; search(text, { now: true }); };
    // → whether the event was the field's
    function handle(e) {
      const name = e.target.getAttribute?.('name');
      if (e.type === 'input' && name === 'source') { search(e.target.value); return true; }
      if (e.type === 'change' && name === 'git-init') {
        gitInit = e.target.checked;
        set(gitInit ? 'ok' : 'init');
        root.querySelector('[data-source-line]').innerHTML = folderLine();
        return true;
      }
      if (e.type !== 'click') return false;
      if (e.target.closest('[data-check-auth]')) { reload(); return true; }
      const pick = e.target.closest('[data-repo], [data-source-pick]');
      if (pick) { fill(pick.dataset.repo || pick.dataset.sourcePick); return true; }
      return false;
    }
    search(typed, { now: true });
    return {
      state, handle,
      // The hub's list arrived: suggestions and a typed owner/name read it again.
      refresh() { if (['empty', 'typing'].includes(status)) search(typed, { now: true }); },
      destroy() { ++version; clearTimeout(timer); },
    };
  }
  // New (no current) opens on a Board | Course switch when course is given: Board's step 1 is the one source field and
  // its step 2 the board's details, posted through save; Course takes a name, what to learn and an optional source, posted
  // through course (docs/adr/2026-11-18-0600-new-starts-a-board-or-a-teach-course.md). With current it is Change repo.
  // A folder is a board worked in place (docs/adr/2026-11-18-0724-a-new-board-can-anchor-on-a-folder-on-this-mac.md).
  // A disabled Next or Start says why above the buttons.
  function repoSheet({ current, save, course, onClose = () => {} }) {
    if (document.getElementById('newBoardSheet')) return () => {};
    const previous = document.activeElement;
    const el = document.createElement('dialog');
    el.setAttribute('id', 'newBoardSheet');
    el.setAttribute('class', 'sheet');
    el.setAttribute('aria-labelledby', 'newBoardTitle');
    const { esc } = BoardUI;
    const draft = { name: '', purpose: '', github: '', remote: '', folder: '', branch: '', tickets: { source: 'none' } };
    const courseDraft = { name: '', learn: '', typed: '' };
    let kind = 'board', boardTyped = '', place = null, gitInit = false;
    let tickets, field = null, list = null;
    let selected, edited = false, sending = false, closed = false, generation = 0, linear;
    const controller = new AbortController();
    el.innerHTML = `<form class="nb-form"><div class="sheet-head"><h2 id="newBoardTitle" tabindex="-1" autofocus>${current ? 'Change repo' : 'New'}</h2><button type="button" data-cancel-new aria-label="Close sheet">✕</button></div>${course && !current ? '<div class="segments nb-kind" role="group" aria-label="What to make"><button type="button" data-nb-kind="board" aria-pressed="true">Board</button><button type="button" data-nb-kind="course" aria-pressed="false">Course</button></div>' : ''}<div class="nb-body" data-repo-content></div><p class="nb-error" role="alert" hidden></p><div class="nb-foot sheet-actions"><p class="nb-reason" data-nb-reason hidden></p><div class="nb-actions"><button type="button" data-cancel-new>Cancel</button><button type="button" class="primary" data-nb-next hidden disabled>Next</button><button type="submit" class="primary" hidden disabled>${current ? 'Use repo' : 'Start'}</button></div></div></form>`;
    const content = el.querySelector('[data-repo-content]');
    const form = el.querySelector('form');
    const start = el.querySelector('[type="submit"]');
    const next = el.querySelector('[data-nb-next]');
    const reason = el.querySelector('[data-nb-reason]');
    const error = el.querySelector('[role="alert"]');
    const named = (name) => el.querySelector(`[name="${name}"]`);
    const request = async (url, options = {}) => {
      const r = await fetch(url, { ...options, signal: controller.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load repos. Try again.');
      return d;
    };
    const fail = (e) => { if (!closed) { error.textContent = e.message; error.hidden = false; } };
    // A course's route as the hub makes it from the name (hub/routes.mjs routeFromName).
    const courseRoute = () => courseDraft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41).replace(/-+$/, '');
    const routeHelp = () => (courseRoute() ? `Opens at /${esc(courseRoute())}/` : 'Letters and digits make its address.');
    const say = (text) => { reason.textContent = text; reason.hidden = !text; };
    const SOURCE_WHY = { checking: 'Checking the source…', bad: 'Fix the source to continue.', init: 'Turn on Make it a git repo to continue.' };
    function sync() {
      if (kind === 'course') {
        const s = field.state();
        const sourceOk = s.status === 'empty' || s.status === 'ok';
        start.disabled = sending || !courseRoute() || !courseDraft.learn.trim() || !sourceOk;
        say(sending || !start.disabled ? '' : !courseRoute() ? 'Name the course to start.' : !courseDraft.learn.trim() ? 'Say what you want to learn to start.'
          : s.status === 'checking' ? SOURCE_WHY.checking : 'Fix the source, or clear it, to start.');
        return;
      }
      if (field) {
        const s = field.state();
        next.disabled = s.status !== 'ok';
        say(!next.disabled ? '' : SOURCE_WHY[s.status] || (current ? 'Choose a repo to continue.' : 'Choose a repo, a remote or a folder to continue.'));
        return;
      }
      start.disabled = sending || !(draft.github || draft.remote || draft.folder) || !draft.branch || (!current && (!draft.name.trim() || !draft.purpose.trim() || !tickets?.valid()));
      say(sending || !start.disabled ? '' : !draft.branch ? 'Waiting for the branch list.' : !draft.name.trim() ? 'Name the board to start.'
        : !draft.purpose.trim() ? 'Add a description to start.' : 'Finish Tickets to start.');
    }
    // The hub's repos and recent sources, which every source field reads; fresh asks gh again.
    async function loadRepos(fresh = false) {
      list = null;
      field?.refresh();
      try { list = await request(`/_hub/repos${fresh ? '?fresh=1' : ''}`); }
      catch (e) { if (closed) return; list = { signedIn: false, repos: [] }; fail(e); }
      if (!closed) field?.refresh();
    }
    const mountField = (root, use, value) => sourceField(root, { use, value, list: () => list, reload: () => loadRepos(true), request, signal: controller.signal,
      change(s) { if (kind === 'course') courseDraft.typed = s.typed; else boardTyped = s.typed; if (field) sync(); } });
    function leave() {
      tickets?.destroy();
      tickets = null;
      field?.destroy();
      field = null;
      ++generation;
      selected = null;
      error.hidden = true;
    }
    function coursePane() {
      leave();
      content.innerHTML = `<label class="nb-field"><span>Name</span><input name="course-name" type="text" value="${esc(courseDraft.name)}" required maxlength="60" autocomplete="off"><span class="nb-help" data-course-route>${routeHelp()}</span></label>`
        + `<label class="nb-field"><span>What do you want to learn?</span><textarea name="learn" rows="3" required maxlength="1000">${esc(courseDraft.learn)}</textarea><span class="nb-help">Start runs /teach and writes lesson 1.</span></label><div data-source></div>`;
      next.hidden = true;
      start.hidden = false;
      field = mountField(content.querySelector('[data-source]'), 'course', courseDraft.typed);
      sync();
    }
    function switchKind(value) {
      if (value === kind) return;
      kind = value;
      el.querySelectorAll('[data-nb-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nbKind === kind)));
      if (kind === 'course') coursePane(); else picker();
    }
    // Step 1: the source field, then Next.
    function picker() {
      leave();
      content.innerHTML = `<p class="nb-next nb-step">${current ? 'Choose a repo' : 'Step 1 of 2 · Choose a source'}</p><div data-source></div>`;
      start.hidden = true;
      next.hidden = false;
      field = mountField(content.querySelector('[data-source]'), current ? 'change' : 'board', boardTyped);
      sync();
    }
    const back = () => `<button type="button" class="nb-back" data-back-repos>‹ Back</button>`;
    const stepTwo = (title) => `<p class="nb-next nb-step">${current ? title : `Step 2 of 2 · ${title}`}</p>`;
    const dotLine = (colour, text) => BoardUI.iconText('dot', colour, text);
    const foundLine = (found) => (found.github ? dotLine('green', `Git repo · github.com/${found.github} · ${found.branch}`)
      : found.remote ? dotLine('green', `Git repo · ${found.remote} · ${found.branch}`)
        : found.git ? dotLine('blue', 'Git repo · no remote · lands won’t push')
          : dotLine('blue', 'Will be a git repo · no remote · lands won’t push'));
    // Step 2 for a folder: its line, its branch (main for a folder git init makes a repo), and the board's details.
    function folderDetails() {
      leave();
      Object.assign(draft, { github: place.github || '', remote: '', folder: place.path, branch: place.branch });
      selected = { clone: place.path, cloned: true };
      if (!edited) draft.name = place.folder.split('/').at(-1);
      next.hidden = true;
      const lands = place.github || place.remote ? `lands fast-forward ${place.branch} in this folder` : `lands fast-forward ${place.branch} and never push`;
      content.innerHTML = `${back()}${stepTwo('Board details')}<div class="nb-selected"><strong>${esc(place.folder)}</strong><span class="nb-help">${foundLine(place)}</span></div><label class="nb-field"><span>Default branch for this board</span><select name="branch"${place.git ? '' : ' disabled'}>${place.branches.map((b) => `<option value="${esc(b)}"${b === draft.branch ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select><span class="nb-help" data-branch-help>${place.git ? `Read from the folder. New implementers branch from ${esc(draft.branch)}.` : 'A new repo starts on main.'}</span></label>${detailFields()}<p class="nb-next">On this board, ${lands}. Implementers work in worktrees off this folder.</p>`;
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
    // Step 2 for a repo: where it is cloned, its branch, and the board's details.
    async function pick(repo) {
      leave();
      selected = repo;
      const version = generation;
      const id = idOf(repo);
      draft.github = repo.github || '';
      draft.remote = repo.remote || '';
      draft.folder = '';
      draft.branch = '';
      if (!edited) draft.name = nameOf(repo).split('/').at(-1);
      next.hidden = true;
      const shared = repo.shared.map((b) => b.title).join(', ');
      content.innerHTML = `${back()}${stepTwo(current ? 'Repo details' : 'Board details')}<div class="nb-selected"><strong>${esc(nameOf(repo))}</strong><span class="nb-help">${esc(access(repo))}</span><p>${repo.cloned ? shared ? `Shared with ${esc(shared)}` : 'Already cloned' : 'Clones to'}<code class="nb-clone">${esc(repo.clone)}</code></p></div><label class="nb-field"><span>Default branch for this board</span><select name="branch" disabled><option value="">Loading branches…</option></select><span class="nb-help" data-branch-help></span></label><p class="nb-next">Each board’s implementers work in separate worktrees off this clone. Sharing the clone doesn’t share their working files.</p>${current ? '<p class="nb-next">New implementers and GitHub links will use the selected repo.</p>' : `${detailFields()}<p class="nb-next">The hub ${repo.cloned ? 'reuses the clone' : 'clones the repo'} and starts your board. You can keep using your other boards.</p>`}`;
      if (!current) mountTickets();
      start.hidden = false;
      sync();
      try {
        const d = await request(`/_hub/branches?${draft.remote ? 'remote' : 'github'}=${encodeURIComponent(id)}`);
        if (closed || generation !== version) return;
        draft.branch = (current?.github || current?.remote) === id && d.branches.includes(current.branch) ? current.branch : d.defaultBranch;
        if (!d.branches.includes(draft.branch)) draft.branch = d.branches[0] || '';
        named('branch').innerHTML = d.branches.map((b) => `<option value="${esc(b)}"${b === draft.branch ? ' selected' : ''}>${esc(b)}${b === d.defaultBranch ? ' (repo default)' : ''}</option>`).join('');
        named('branch').value = draft.branch;
        named('branch').disabled = false;
        el.querySelector('[data-branch-help]').textContent = draft.branch ? `New implementers branch from ${draft.branch}.` : 'This repo has no branches yet.';
        sync();
      } catch (e) { fail(e); }
    }
    function nextStep() {
      const s = field.state();
      if (s.status !== 'ok') return;
      if (s.place) { place = s.place; gitInit = s.gitInit; folderDetails(); } else pick(s.repo);
    }
    const done = () => { if (!sending) el.close(); };
    form.addEventListener('click', (e) => {
      if (sending) return;
      if (e.target.closest('[data-cancel-new]')) done();
      else if (e.target.closest('[data-nb-kind]')) switchKind(e.target.closest('[data-nb-kind]').dataset.nbKind);
      else if (e.target.closest('[data-nb-next]')) { if (!next.disabled) nextStep(); }
      else if (e.target.closest('[data-back-repos]')) picker();
      else field?.handle(e);
    });
    form.addEventListener('input', (e) => {
      if (field?.handle(e)) return;
      if (e.target.getAttribute('name') === 'name') { draft.name = e.target.value; edited = true; tickets?.nameChanged(); }
      if (e.target.getAttribute('name') === 'purpose') draft.purpose = e.target.value;
      if (e.target.getAttribute('name') === 'course-name') { courseDraft.name = e.target.value; el.querySelector('[data-course-route]').innerHTML = routeHelp(); }
      if (e.target.getAttribute('name') === 'learn') courseDraft.learn = e.target.value;
      sync();
    });
    form.addEventListener('change', (e) => {
      if (field?.handle(e)) return;
      if (e.target.getAttribute('name') === 'branch') {
        draft.branch = e.target.value;
        el.querySelector('[data-branch-help]').textContent = `New implementers branch from ${draft.branch}.`;
        sync();
      }
    });
    // A course's source as the hub takes it (hub/new-course.mjs): github, remote or folder, else none.
    const courseSource = ({ repo, place: at }) => (at ? { folder: at.path } : repo ? (repo.remote ? { remote: repo.remote } : { github: repo.github }) : {});
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (sending || start.disabled || (kind === 'board' && !selected)) return;
      sending = true;
      sync();
      error.hidden = true;
      try {
        if (kind === 'course') {
          const s = field.state();
          await BoardUI.waitOn(start, course({ name: courseDraft.name.trim(), learn: courseDraft.learn.trim(), ...courseSource(s) }, s.repo));
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
      leave();
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
    loadRepos();
    return () => { sending = false; el.close(); };
  }
  const confirm = (message, { signal } = {}) => Promise.resolve(!signal?.aborted && window.confirm(message));
  const notice = (message) => { window.alert(message); return Promise.resolve(); };
  globalThis.BoardDialogs = { confirm, notice, fitSheet, focusField, repoSheet, ticketsControl };
})();
