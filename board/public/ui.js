// Renderers the board's pages share, and the base the other ui-*.js files add to BoardUI. Each returns an HTML
// string and touches no DOM or storage: ui.test.mjs runs these files in node:vm, where neither exists. Load this first.
// fetchJSON is the side pages' one way to read the board's API.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const record = (records, key) => (Object.hasOwn(records || {}, key) ? records[key] : undefined);
  const time = (iso) => new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ago = (iso) => {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  };
  const since = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  };
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)$/i, (_, m) => ` ${m.toLowerCase()}`);
  // "ETA about 4:30 pm", with the day when it isn't today.
  function etaLine(iso, now = new Date()) {
    const d = new Date(iso);
    const day = d.toDateString() === now.toDateString() ? '' : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, `;
    return `ETA about ${day}${clock(d)}`;
  }
  const replyBody = (reply) => reply.html ?? esc(JSON.stringify(reply.json));

  // Attachments are uploads from POST /api/upload: {name, url, path, type, size}. Only uploads/ URLs become links.
  const uploadUrl = (f) => (/^uploads\/[\w.-]+$/.test(f.url || '') ? f.url : null);
  const isImage = (f) => /^image\//.test(f.type || '');
  function attachments(files) {
    if (!files?.length) return '';
    return `<div class="files">${files.map((f) => {
      const url = uploadUrl(f);
      if (!url) return `<span class="file-link">${esc(f.name)}</span>`;
      return isImage(f)
        ? `<a class="file-thumb" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(f.name)}"><img src="${esc(url)}" alt="${esc(f.name)}" loading="lazy"></a>`
        : `<a class="file-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`;
    }).join('')}</div>`;
  }
  const CLIP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  const attachButton = () => `<label class="attach" title="Attach files"><input type="file" multiple data-attach aria-label="Attach files">${CLIP}</label>`;
  const icon = (body, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const EYE = icon('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>');
  const TRASH = icon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
  const ELLIPSIS = icon('<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>');
  // Asks Claude for throwaway prototypes of one item (docs/adr/0015-prototypes-come-on-request.md).
  function protoButton(id, state = null) {
    if (state?.pending) return `<button type="button" class="attach proto-ask" data-proto="${esc(id)}" data-proto-pending="${esc(state.pending)}" aria-label="Prototypes are being made" title="Prototypes are being made">${ELLIPSIS}</button>`;
    return `<button type="button" class="attach proto-ask" data-proto="${esc(id)}" aria-label="Ask for prototypes" title="Ask for prototypes">${EYE}</button>`;
  }
  // latestBump is the data.id of the newest ask-bump event.
  const protoNotice = (eventId, latestBump) => (latestBump === eventId
    ? { text: 'Prototypes are being made.', bump: false }
    : { text: 'Prototypes are being made. Bump them to the top of the queue?', bump: true });
  const PENCIL = icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
  const BUMP = icon('<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>');
  // Deletes or edits a pending ask or thread message; app-asks.js handles [data-withdraw] and [data-edit] on one path.
  const withdrawButton = (id) => `<button class="ghost icon" data-withdraw="${esc(id)}" aria-label="Delete" title="Delete">${TRASH}</button>`;
  const editButton = (id) => `<button class="ghost icon" data-edit="${esc(id)}" aria-label="Edit" title="Edit">${PENCIL}</button>`;
  // A waiting ask's bump, which app-asks.js sends as ask-bump {id}. A work card's is the same icon, which app-cards.js
  // confirms before it sends card-bump {key} (docs/adr/0019-a-card-that-hasnt-started-can-be-bumped.md).
  const bumpButton = (it, top) => `<button class="ghost icon" data-bump="${esc(it.id)}" aria-label="Bump to top" title="Bump to top"${top ? ' disabled' : ''}>${BUMP}</button>`;
  const cardBumpButton = (key, top) => `<button class="ghost icon" data-confirm="bump" data-key="${esc(key)}" aria-label="Bump to top" title="Bump to top"${top ? ' disabled' : ''}>${BUMP}</button>`;
  const workingLine = '<span class="working-dot" aria-hidden="true"></span>Working on it';
  // html is markup the caller has escaped; href, title and attrs values are escaped here.
  const BADGE_TONES = Object.freeze(['quiet', 'normal', 'notice', 'danger', 'ready']);
  function badge(tone, html, { href, title, button = false, attrs = {} } = {}) {
    if (!BADGE_TONES.includes(tone)) throw new Error(`unknown badge tone: ${tone}`);
    const extra = Object.entries({ href, title, ...attrs }).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const tag = button ? 'button' : href == null ? 'span' : 'a';
    return `<${tag} class="chip tone-${tone}"${extra}>${html}</${tag}>`;
  }
  // A composer's files before sending: {id, name, type, preview, status: uploading|done|error, progress (0–1), error}.
  const pendingFiles = (list) => list.map((p) => `<span class="pfile ${esc(p.status)}" title="${esc(p.name)}">
      ${isImage(p) && p.preview ? `<img src="${esc(p.preview)}" alt="${esc(p.name)}">` : `<span class="pname">${esc(p.name)}</span>`}
      ${p.status === 'uploading' ? `<span class="pbar" role="progressbar" aria-label="Uploading ${esc(p.name)}" aria-valuenow="${Math.round((p.progress || 0) * 100)}"><span style="width:${Math.max(4, Math.round((p.progress || 0) * 100))}%"></span></span>` : ''}
      ${p.status === 'error' ? `<span class="perr">${esc(p.error || 'Upload failed')}</span>` : ''}
      <button type="button" class="unattach" data-unattach="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button></span>`).join('');

  // Replacing innerHTML would close every <details> inside, collapsing what the reader had open, and replace the field
  // being typed in, dropping its text, cursor and focus, and on iOS the keyboard. So setHTML patches el in place: a
  // node stays when the new markup has one of its tag at its place, and an element with a key (keyOf) stays wherever
  // under el it was, so a card that moves lanes keeps its open thread. A textarea keeps what was typed in it, and an
  // element matching opts.keep stays as it is, for markup another part paints. The focused field keeps its focus when
  // its card moves (focusSafe). setHTML skips an unchanged rebuild, and reopens each <details> the reader left open,
  // matched by its owning [data-key] and summary text. Open state is tracked page-wide, so content filled in after a
  // parent rebuild reopens too.
  const lastHtml = new WeakMap();
  const openDetails = new Set();
  const detailsKey = (d) => `${(d.closest('[data-key]') || {}).dataset?.key || ''}|${(d.querySelector(':scope > summary')?.textContent || '').trim()}`;
  globalThis.document?.addEventListener('toggle', (ev) => {
    if (ev.target.tagName !== 'DETAILS') return;
    if (ev.target.open) openDetails.add(detailsKey(ev.target)); else openDetails.delete(detailsKey(ev.target));
  }, true);
  const KEYS = ['id', 'data-thread', 'data-event', 'data-edit-form', 'data-lane', 'data-fold'];
  function keyOf(n) {
    if (n.nodeType !== 1) return null;
    if (n.tagName === 'DETAILS' && n.hasAttribute('data-key')) return `DETAILS|${n.getAttribute('data-key')}`;
    const a = KEYS.find((k) => n.hasAttribute(k));
    return a ? `${n.tagName}|${a}=${n.getAttribute(a)}` : null;
  }
  function keyedUnder(el, keep) {
    const keyed = new Map();
    const walk = (p) => {
      for (const c of p.children) {
        const k = keyOf(c);
        if (k && !keyed.has(k)) keyed.set(k, c);
        if (!(keep && c.matches(keep))) walk(c);
      }
    };
    walk(el);
    return keyed;
  }
  const holdsFocus = (n) => n.contains(document.activeElement);
  // insertBefore blurs the node it moves, and on iOS closes the keyboard; moveBefore keeps its focus, but moves only
  // between connected nodes.
  function move(parent, n, ref) {
    if (parent.moveBefore && n.isConnected && parent.isConnected) parent.moveBefore(n, ref);
    else parent.insertBefore(n, ref);
  }
  // Without moveBefore, the focused field's ancestors under el never move: each is patched into the node at the same
  // depth on the path to the field's nearest keyed ancestor in the new markup, so a card that changes lanes takes over
  // the old lane's node. → Map from each new markup node on that path to the old node it patches; empty when the
  // paths' depths or tags differ, and app-core.js keepFocus refocuses the field after the move.
  function focusSafe(el, next, keyed) {
    const pins = new Map();
    const a = document.activeElement;
    if (el.moveBefore || !a || a === el || !el.contains(a)) return pins;
    const olds = [];
    for (let n = a; n !== el; n = n.parentNode) olds.unshift(n);
    for (let i = olds.length - 1; i >= 0; i--) {
      const k = keyOf(olds[i]);
      const found = k && [...next.querySelectorAll('*')].find((d) => keyOf(d) === k);
      if (!found) continue;
      const news = [];
      for (let n = found; n !== next; n = n.parentNode) news.unshift(n);
      if (news.length !== i + 1 || news.some((n, j) => n.tagName !== olds[j].tagName)) return pins;
      news.forEach((n, j) => { pins.set(n, olds[j]); keyed.delete(keyOf(olds[j])); });
      return pins;
    }
    return pins;
  }
  // ctx: {keyed, keep, pins, pinned}, pinned being the old nodes in pins, which only their own new node takes.
  function patchNode(old, next, ctx) {
    if (old.nodeType !== 1) { if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue; return; }
    if (ctx.keep && old.matches(ctx.keep)) return;
    for (const { name } of [...old.attributes]) if (!next.hasAttribute(name)) old.removeAttribute(name);
    for (const { name, value } of [...next.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
    if (old.tagName !== 'TEXTAREA') patchChildren(old, next, ctx);
  }
  function patchChildren(parent, next, ctx) {
    const { keyed, pins, pinned } = ctx;
    let cur = parent.firstChild;
    for (const n of [...next.childNodes]) {
      const k = keyOf(n);
      let match = pins.get(n) || null;
      if (!match && k) {
        match = keyed.get(k) || null;
        if (match?.contains(parent)) match = null;
        if (match) keyed.delete(k);
      } else if (!match && cur && !keyOf(cur) && !pinned.has(cur) && cur.nodeName === n.nodeName) match = cur;
      if (!match) {
        parent.insertBefore(n, cur);
        if (n.nodeType === 1) {
          for (const d of n.querySelectorAll('*')) {
            const dk = n.contains(d) && keyOf(d);
            const old = dk && keyed.get(dk);
            if (!old || old.contains(n)) continue;
            keyed.delete(dk);
            move(d.parentNode, old, d);
            d.remove();
            patchNode(old, d, ctx);
          }
        }
        continue;
      }
      if (match === cur) cur = cur.nextSibling;
      else if (match.parentNode === parent && holdsFocus(match)) {
        // Moving the node that holds focus would blur it, so the siblings before it leave instead.
        while (cur !== match) { const after = cur.nextSibling; cur.remove(); cur = after; }
        cur = match.nextSibling;
      } else move(parent, match, cur);
      patchNode(match, n, ctx);
    }
    while (cur) { const after = cur.nextSibling; cur.remove(); cur = after; }
  }
  function setHTML(el, html, { keep = null } = {}) {
    if (lastHtml.get(el) === html) return false;
    if (!el.firstChild) el.innerHTML = html;
    else {
      const t = document.createElement('template');
      t.innerHTML = html;
      const keyed = keyedUnder(el, keep);
      const pins = focusSafe(el, t.content, keyed);
      patchChildren(el, t.content, { keyed, keep, pins, pinned: new Set(pins.values()) });
    }
    lastHtml.set(el, html);
    if (openDetails.size) for (const d of el.querySelectorAll('details:not([open])')) if (openDetails.has(detailsKey(d))) d.open = true;
    return true;
  }

  // While a board restarts, the hub answers its own 502 page, and a request can fail outright. fetchJSON waits that out:
  // on a network error, a 5xx or a body that isn't JSON it calls onWait(waitedMs) and retries with a growing backoff,
  // then throws once about limit ms have passed. Any other answer resolves {ok, status, body}, a 404's {error} included.
  const RESTARTING = 'Board restarting…';
  const restartNotice = () => `<span class="muted small restarting">${RESTARTING}</span>`;
  async function fetchJSON(url, { onWait = () => {}, limit = 30000, fetch: get = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let waited = 0;
    let delay = 500;
    for (;;) {
      let failure;
      try {
        const r = await get(url, { cache: 'no-store' });
        const body = await r.text().then((t) => JSON.parse(t)).catch(() => undefined);
        if (body !== undefined && r.status < 500) return { ok: r.ok, status: r.status, body };
        failure = new Error(r.status >= 500 ? `the board answered ${r.status}` : 'the board did not answer with JSON');
      } catch { failure = new Error('Offline. Is the host awake?'); }
      if (waited >= limit) throw failure;
      onWait(waited);
      await sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, 4000);
    }
  }

  globalThis.BoardUI = {
    esc, record, time, ago, since, etaLine, replyBody, setHTML, fetchJSON, RESTARTING, restartNotice,
    attachments, attachButton, pendingFiles, protoButton, protoNotice, withdrawButton, editButton, bumpButton, cardBumpButton, workingLine, BADGE_TONES, badge,
  };
})();
