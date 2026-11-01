// Links the refs in Claude- and owner-written text as the board renders it, so no one links a ref by hand: a card's
// ref opens that card, a Linear id or PR opens its page, and a bare URL becomes a link. Needs ui.js; load it before
// the ui-*.js files that render text.
(function () {
  const { esc, record } = globalThis.BoardUI;
  // The Linear id shape store.mjs accepts for a follow-up, which an internal ref shares.
  const LINEAR_ID = /^([A-Z][A-Z0-9]*)-\d+$/;
  const LINEAR_ISSUE = /^https:\/\/linear\.app\/[^/]+\/issue\//;
  const prUrl = (repo, n) => `https://github.com/${repo}/pull/${n}`;

  // What a renderer needs to link text shown on item `key` (null for none): each ref to its card's key, the issue url
  // prefix of each Linear team the board's cards link to (none on a board without a workspace), that item's repo for
  // a bare #n, and `base`, which a page other than the board sets to './' so a card link opens the board. A ref shaped
  // like a Linear id, such as INT-<n>, links from anywhere; a wave's own short id, such as B1, links only from that
  // wave's cards, since a plan for another wave reuses those names.
  function linkContext(items = [], key = null, { base = '' } = {}) {
    const wave = key && !key.startsWith('ask:') ? key.slice(0, key.indexOf('/')) : null;
    const byRef = new Map();
    for (const i of items) {
      if (i.kind === 'ask' || !i.ref || (!LINEAR_ID.test(i.ref) && i.wave !== wave)) continue;
      byRef.set(i.ref, [...(byRef.get(i.ref) || []), i]);
    }
    const refs = Object.create(null);
    for (const [ref, list] of byRef) {
      const pick = list.length === 1 ? list[0] : list.find((i) => i.wave === wave);
      if (pick) refs[ref] = pick.key;
    }
    const teams = Object.create(null);
    const repos = Object.create(null);
    for (const i of items) {
      if (i.repo) repos[i.repo.split('/')[1]] = i.repo;
      if (i.internal) continue;
      for (const l of i.linear || []) {
        const team = LINEAR_ID.exec(l.id || '')?.[1];
        const prefix = LINEAR_ISSUE.exec(l.url || '')?.[0];
        if (team && prefix && !teams[team]) teams[team] = prefix;
      }
    }
    return { refs, teams, repos, repo: items.find((i) => i.key === key)?.repo || null, base };
  }

  const TOKEN = new RegExp([
    String.raw`(https?:\/\/[^\s<>"'\u0000-\u001f]+)`,
    String.raw`(?<![\w.\/-])(?:([A-Za-z0-9][\w.-]*)\/)?([A-Za-z0-9][\w.-]*)#(\d+)(?!\w)`,
    String.raw`(?<![\w&#\/])#(\d+)(?!\w)`,
    String.raw`(?<![\w-])([A-Za-z]\w*(?:-\w+)*)`,
  ].join('|'), 'g');
  const out = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  // A link to a page on this hub opens in place; only another origin opens a new window.
  const opensHere = (href) => !/^[a-z][\w+.-]*:/i.test(href) || Boolean(globalThis.location?.origin && href.startsWith(location.origin + '/'));
  const anyLink = (href, label) => (opensHere(href) ? `<a href="${esc(href)}">${esc(label)}</a>` : out(href, label));
  const count = (s, c) => s.split(c).length - 1;

  // Trailing punctuation ends a sentence, not the URL, unless it closes a bracket the URL opened.
  function urlLink(raw) {
    let url = raw;
    while (/[.,;:!?)\]]$/.test(url)) {
      const c = url.at(-1);
      if ((c === ')' && count(url, '(') >= count(url, ')')) || (c === ']' && count(url, '[') >= count(url, ']'))) break;
      url = url.slice(0, -1);
    }
    return anyLink(url, url) + esc(raw.slice(url.length));
  }

  // The longest hyphen-prefix of a word that is a known ref or a Linear id, then the rest as text.
  function wordLink(word, ctx) {
    for (let w = word; w; w = w.includes('-') ? w.slice(0, w.lastIndexOf('-')) : '') {
      const rest = esc(word.slice(w.length));
      if (record(ctx.refs, w)) return `<a href="${esc(`${ctx.base || ''}#item=${encodeURIComponent(record(ctx.refs, w))}`)}">${esc(w)}</a>${rest}`;
      const team = LINEAR_ID.exec(w)?.[1];
      const prefix = team && team !== 'INT' && record(ctx.teams, team);
      if (prefix) return out(prefix + w, w) + rest;
    }
    return esc(word);
  }

  // A bare #n that reads as a hex colour stays text.
  const colour = (n) => n.startsWith('0') || n.length === 6 || n.length === 8;

  // Plain text in, escaped HTML out, with each ref linked.
  function linkText(text, ctx = {}) {
    const s = String(text ?? '');
    let html = '';
    let at = 0;
    for (const m of s.matchAll(TOKEN)) {
      const [all, url, owner, name, n, bare, word] = m;
      html += esc(s.slice(at, m.index));
      at = m.index + all.length;
      if (url) html += urlLink(url);
      else if (name) {
        const repo = owner ? `${owner}/${name}` : record(ctx.repos, name);
        html += repo ? out(prUrl(repo, n), all) : esc(all);
      } else if (bare) html += ctx.repo && !colour(bare) ? out(prUrl(ctx.repo, bare), all) : esc(all);
      else html += wordLink(word, ctx);
    }
    return html + esc(s.slice(at));
  }

  const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  // Text inside these stays as written: a link can't nest in a link or a control, and preformatted text is code.
  const KEEP = new Set(['a', 'button', 'label', 'option', 'pre', 'script', 'select', 'style', 'textarea']);
  const ENTITY = /(&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]*);)/i;
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decode(e) {
    const n = e.slice(1, -1).toLowerCase();
    if (n[0] !== '#') return record(NAMED, n) ?? null;
    const code = n[1] === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
  }
  // An HTML text run, decoded and relinked; an entity with no plain-text form is kept as written.
  function linkRun(run, ctx) {
    let html = '';
    let buf = '';
    for (const [n, part] of run.split(ENTITY).entries()) {
      const plain = n % 2 ? decode(part) : part;
      if (plain !== null) { buf += plain; continue; }
      html += linkText(buf, ctx) + part;
      buf = '';
    }
    return html + linkText(buf, ctx);
  }

  // An HTML fragment Claude wrote, with refs linked in its text outside links, controls and <pre>.
  function linkHtml(html, ctx = {}) {
    const s = String(html ?? '');
    let res = '';
    let at = 0;
    let keep = 0;
    for (const m of s.matchAll(TAG)) {
      const run = s.slice(at, m.index);
      res += keep ? run : linkRun(run, ctx);
      res += m[0];
      at = m.index + m[0].length;
      const name = (m[2] || '').toLowerCase();
      if (KEEP.has(name) && !m[0].endsWith('/>')) keep = Math.max(0, keep + (m[1] ? -1 : 1));
    }
    const tail = s.slice(at);
    return res + (keep ? tail : linkRun(tail, ctx));
  }

  Object.assign(globalThis.BoardUI, { linkContext, linkText, linkHtml, opensHere, anyLink });
})();
