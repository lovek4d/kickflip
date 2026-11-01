// The sidebar of every site (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md), drawn from the hub's
// /_hub/sidebar.json. It needs only ui-page-header.js, loaded before it, for its head, which is the page header itself:
// the app shell runs it through sidebar.js, and hub/hub.mjs renders the shell's first sidebar with both in a vm context.
// Its links are root-absolute, since every site and hub page sits beside this one on the hub. sidebar.css styles it.
(function () {
  // ui.js replaces the BoardUI global when it loads after this, so the header renderer is held here.
  const { header } = globalThis.BoardUI || {};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (paths, size = 17) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  const tile = (key, color) => `<span class="icon sm solid" style="--c:${color}" aria-hidden="true">${svg(ICONS[key])}</span>`;
  const word = (tone, text) => `<span class="dot t-${tone}" aria-hidden="true"></span><span class="word t-${tone}">${esc(text)}</span>`;
  const usageProducts = (data) => ['claude', 'codex'].filter((p) => data?.[p]);
  const usageNames = { claude: 'Claude', codex: 'Codex' };
  function usageClock(iso) {
    const d = new Date(iso ?? '');
    if (!Number.isFinite(d.getTime())) return '—';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M/i, (_, x) => `${x.toLowerCase()}m`);
    return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  const usageTone = (w) => !w ? 'none' : w.state === 'stale' ? 'stale' : w.used_percentage >= 90 ? 'full' : w.used_percentage >= 75 ? 'high' : 'ok';
  const usageBar = (w) => `<span class="u-bar" aria-hidden="true"><i style="width:${w?.state === 'stale' ? 0 : Math.max(0, Math.min(100, w?.used_percentage || 0))}%"></i></span>`;
  function usageWords(reading, key) {
    const w = reading[key];
    if (!w) return 'No reading';
    if (w.state === 'stale') return `${Math.round(w.used_percentage)}% at ${esc(usageClock(reading.at))}`;
    if (w.state === 'reset') return `Reset ${esc(usageClock(w.resets_at))}`;
    return `<span class="u-num">${Math.round(w.used_percentage)}%</span> · resets ${esc(usageClock(w.resets_at))}`;
  }
  function sidebarUsage(data) {
    const products = usageProducts(data);
    return products.length ? `<span class="sb-usage">${products.map((p) => {
      const r = data[p];
      const w = r.five_hour;
      const name = `<span class="u-name">${usageNames[p]}</span>`;
      const words = !w ? `${name} · no reading yet`
        : w.state === 'stale' ? `${name} · last seen ${esc(usageClock(r.at))}`
          : w.state === 'reset' ? `${name} · reset ${esc(usageClock(w.resets_at))}`
            : `${name} ${usageWords(r, 'five_hour')}`;
      return `<span class="u-one u-tone-${usageTone(w)}"><span class="u-line">${words}</span>${usageBar(w)}</span>`;
    }).join('')}</span>` : '';
  }
  // The utility rows, in the order they show.
  const UTILITY = [
    { href: '/_hub/', title: 'Hub', icon: tile('pulse', '#64748b') },
  ];
  const siteHref = (s) => `/${encodeURIComponent(s.route)}/`;

  // Switch mode's keys (sidebar.js; docs/adr/0056-switch-mode-letters-come-from-names-in-join-order.md): each linked row the
  // sidebar draws, boards first for numbering, as {href, title, board, num, letter, at}. The first nine boards take num '1'–'9'.
  // Every row takes as letter the first a–z letter of its title not yet taken, at index `at` of the title's characters,
  // claiming in this order: boards by `created`, then pages by `created`, a site with none after those with one, then
  // the Hub rows. So a new board never takes another board's letter. A row with no letter left gets none.
  function switchKeys(data) {
    const sites = data?.sites || [];
    const site = (rank) => (s) => ({ href: siteHref(s), title: String(s.title ?? s.route), board: rank === 0, rank, joined: Date.parse(s.created) });
    const rows = [...sites.filter((s) => s.board).map(site(0)), ...sites.filter((s) => !s.board).map(site(1)),
      ...UTILITY.map((f, i) => ({ href: f.href, title: f.title, board: false, rank: 2, joined: i }))];
    rows.filter((r) => r.board).slice(0, 9).forEach((r, i) => { r.num = String(i + 1); });
    const when = (r) => (Number.isFinite(r.joined) ? r.joined : Infinity);
    const taken = new Set();
    for (const r of [...rows].sort((a, b) => a.rank - b.rank || when(a) - when(b))) {
      const chars = [...r.title];
      const at = chars.findIndex((c) => /^[a-z]$/.test(c.toLowerCase()) && !taken.has(c.toLowerCase()));
      if (at < 0) continue;
      r.letter = chars[at].toLowerCase();
      r.at = at;
      taken.add(r.letter);
    }
    return rows.map(({ href, title, board, num, letter, at }) => ({ href, title, board, num, letter, at }));
  }

  // key: the row's switchKeys entry while switch mode shows, else undefined. The tile carries a board's number, or any
  // other row's letter, and the title marks its letter; sidebar.css shows them in place of the glyph under .ks-on.
  function row({ href, icon, title, sub = '', extra = '', on = false, cls = '', key }) {
    const shown = key && (key.board ? key.num : key.letter);
    const tileHtml = shown ? icon.replace(/<\/span>$/, `<span class="ks-key">${esc(shown)}</span></span>`) : icon;
    const chars = [...title];
    const titleHtml = key?.letter ? `${esc(chars.slice(0, key.at).join(''))}<span class="ks-u">${esc(chars[key.at])}</span>${esc(chars.slice(key.at + 1).join(''))}` : esc(title);
    return `<a class="sb-row${on ? ' on' : ''}${cls ? ` ${cls}` : ''}" href="${esc(href)}"${on ? ' aria-current="page"' : ''}>${tileHtml}`
      + `<span class="sb-text"><span class="sb-title">${titleHtml}</span>${sub ? `<span class="sb-sub">${sub}</span>` : ''}${extra}</span></a>`;
  }

  // What waits on the owner on every site but `here`: the count on the logo that opens the drawer.
  function othersWaiting(data, here) {
    return (data?.sites || []).reduce((n, s) => n + (s.route === here ? 0 : Number(s.count) || 0), 0);
  }

  function repoLabel(repo, home) {
    if (!home) return repo;
    return repo === home ? '~' : repo.startsWith(`${home}/`) ? `~${repo.slice(home.length)}` : repo;
  }

  // data: /_hub/sidebar.json. here: a site's route or a hub page's path without its leading slash. device: this device's push
  // subscription as sidebar.js finds it, 'on' | 'off' | 'blocked' | 'install' (iOS outside the Home Screen app), or
  // null while unknown or unsupported. switching: switch mode shows, each row with its key and the hint at the foot.
  function sidebar(data, { here = '', device = null, switching = false } = {}) {
    const sites = data?.sites || [];
    const keys = switching ? new Map(switchKeys(data).map((k) => [k.href, k])) : null;
    const siteRow = (s) => row({ href: siteHref(s), icon: s.icon, title: s.title, sub: s.sub ? `<span class="sb-status">${s.sub}</span>` : '', on: s.route === here, key: keys?.get(siteHref(s)) });
    const boards = sites.filter((s) => s.board);
    const pages = sites.filter((s) => !s.board);
    const plus = `<span class="icon sb-plus" aria-hidden="true">${svg(ICONS.plus, 20)}</span>`;
    const pending = (data?.starting || []).map((s) => `<div class="sb-row sb-starting" data-starting="${esc(s.route)}">${plus}`
      + `<span class="sb-text"><span class="sb-title">${s.failed ? "Didn't start" : s.phase === 'cloning' ? 'Cloning…' : 'Starting…'}</span><span class="sb-sub">${esc(s.title)}${s.repo ? ` · ${esc(repoLabel(s.repo, data.home))}` : ''}${s.failed ? '' : s.phase === 'cloning' ? ' · Cloning from GitHub' : ' · Waiting for the board to answer'}</span>${s.error ? `<span class="sb-sub">${esc(s.error)}</span>` : ''}</span>`
      + (s.failed ? `<button type="button" class="sb-dismiss" data-dismiss-board="${esc(s.route)}" aria-label="Dismiss ${esc(s.title)}">Dismiss</button>` : '') + '</div>').join('');
    const newBoard = `<button type="button" class="sb-row sb-new" data-new-board aria-haspopup="dialog">${plus}<span class="sb-text"><span class="sb-title">New board</span></span></button>`;
    const turnOn = device === 'off' ? row({ href: '/_hub/#notifications', icon: tile('bell', '#ef4444'), title: 'Turn on notifications', sub: 'Off on this device', cls: 'sb-turnon' })
      : device === 'install' ? row({ href: '/_hub/#notifications', icon: tile('bell', '#ef4444'), title: 'Add Claude to your Home Screen', sub: 'Notifications come only to the Home Screen app', cls: 'sb-turnon' })
      : '';
    const usage = sidebarUsage(data?.usage);
    const hub = data?.hub;
    const n = data?.notifications || {};
    const lower = (text) => String(text || '').replace(/^\w/, (c) => c.toLowerCase());
    const notify = device === 'blocked' ? word('needs', 'Notifications blocked on this device')
      : n.state === 'off' ? word('needs', `Notifications ${lower(n.text || 'Off')}`)
      : n.state === 'held' ? esc(`Notifications ${lower(n.text)}`) : '';
    const subs = {
      '/_hub/': (hub ? `<span class="sb-status">${word(hub.tone, hub.word)}<span>${esc(hub.detail)}</span></span>` : '')
        + (notify ? `<span class="sb-status">${notify}</span>` : ''),
    };
    const selected = here.startsWith('_hub') ? '/_hub' : `/${here.replace(/\/$/, '')}`;
    const close = `<div class="nav"><button type="button" class="sb-close" data-sidebar-close aria-label="Close boards">${svg(ICONS.close, 20)}</button></div>`;
    return header({ lead: 'logo', title: 'Kickflip', level: 2, controls: false, trail: close, logoSrc: '/_hub/kickflip.png',
      leadAttrs: { 'aria-label': 'Hide boards', title: 'Hide boards', 'data-sidebar-close': '' } })
      + `<div class="sb-scroll"><section class="sb-utility" aria-label="Hub"><div class="sb-group">`
      + UTILITY.map((f) => row({ ...f, on: f.href.replace(/\/$/, '') === selected, sub: subs[f.href], ...(f.href === '/_hub/' && usage ? { extra: usage, cls: 'sb-hub-usage' } : {}), key: keys?.get(f.href) })).join('')
      + `</div>${turnOn}</section>`
      + (pages.length ? `<section class="sb-pages" aria-label="Pages"><div class="sb-label">Pages</div><div class="sb-group">${pages.map(siteRow).join('')}</div></section>` : '')
      + `<section class="sb-boards" aria-label="Boards"><div class="sb-label">Boards</div><div class="sb-group">${boards.map(siteRow).join('')}${pending}${newBoard}</div></section></div>`
      + (switching ? '<div class="ks-hint" role="status"><b>Switch:</b> press a key · Esc to cancel<i class="ks-bar"></i></div>' : '');
  }

  Object.assign(globalThis.BoardUI ||= {}, { sidebar, othersWaiting, switchKeys, repoLabel, usageProducts, usageNames, usageClock, usageTone, usageBar, usageWords });
})();
