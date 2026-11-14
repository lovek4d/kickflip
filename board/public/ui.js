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
  // How long ago a card's status was first set, as its status line ends: "just now", "14m", "3h", "2d"
  // (docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md).
  const lasted = (iso) => ago(iso).replace(/ ago$/, '');
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
  // A card's last line: the time only today, with the day before today, and with the year too past 365 days.
  function cardTime(iso, now = new Date()) {
    const d = new Date(iso);
    const at = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return at;
    const day = d.toLocaleDateString([], { month: 'numeric', day: 'numeric', ...(now - d > 365 * 86400000 ? { year: 'numeric' } : {}) });
    return `${day}, ${at}`;
  }
  // A reply as HTML with its refs linked: a markdown reply drawn by ui-markdown.js, which, like ui-links.js, loads after
  // this file; an older HTML one as written. Its box takes class md for a markdown reply's compact styles.
  const replyBody = (reply, links) => (reply.md ? globalThis.BoardUI.markdown(reply.md, links)
    : globalThis.BoardUI.linkHtml(reply.html ?? esc(JSON.stringify(reply.json)), links));

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
  // A composer's text box with its attach button inside at the bottom right, which attach.js outlines with Drop to
  // attach while files are dragged over the composer. attach: false leaves the button out, for a composer that puts it
  // on its row (app-threads.js).
  const dropZone = (textarea, { attach = true } = {}) => `<div class="dz${attach ? '' : ' bare'}">${textarea}${attach ? attachButton() : ''}<div class="dz-hint" aria-hidden="true">Drop to attach</div></div>`;
  // docs/adr/2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md
  // A composer's send buttons: the one with nth 0 presses on ⌘↵ and the one with nth 1, where there is one, on ⌥↵,
  // wherever each sits in the row (Ctrl+↵ and
  // Alt+↵ off a Mac), each with its key as a small gray hint that style.css shows only where there is a keyboard and room.
  // tone is its class: primary for the nth 0 one unless given, as resolves on the Send or Reply that clears Action needed.
  const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
  const SEND_KEYS = MAC ? ['⌘↵', '⌥↵'] : ['Ctrl+↵', 'Alt+↵'];
  const sendButton = (label, nth, attrs = '', tone = nth === 0 ? 'primary' : '') => `<button type="submit"${tone ? ` class="${tone}"` : ''} data-nth="${nth}"${attrs}>${esc(label)}<span class="key-hint" aria-hidden="true">${SEND_KEYS[nth]}</span></button>`;
  // The send button an Enter keydown in form's box presses, or null.
  const keyedSend = (ev, form) => {
    if (ev.key !== 'Enter' || ev.isComposing) return null;
    const nth = (ev.metaKey || ev.ctrlKey) && !ev.altKey ? 0 : ev.altKey && !ev.metaKey && !ev.ctrlKey ? 1 : -1;
    return nth < 0 ? null : form.querySelector(`button[type="submit"][data-nth="${nth}"]`);
  };
  const icon = (body, size = 18, attrs = '') => `<svg${attrs} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  // An SVG, not ↗: iOS Safari can draw ↗ as an emoji tile even with U+FE0E.
  const LINK_ARROW = icon('<path d="M7 17 17 7"/><path d="M7 7h10v10"/>', '1em', ' class="link-arrow" style="vertical-align:-0.125em"');
  // Escaped text with each ↗ (and a trailing U+FE0E) drawn as LINK_ARROW; for owner-facing text, never an attribute.
  const escText = (s) => esc(s).replace(/\u2197\uFE0E?/g, LINK_ARROW);
  const EYE = icon('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>');
  const TRASH = icon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
  const FIRE = icon('<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/>');
  const IMAGE_PATHS = '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>';
  // Asks Claude for throwaway prototypes of one item (docs/adr/2026-10-29-1639-prototypes-come-on-request.md): a
  // question's eye sends at once; a thread's eye is a toggle that Send carries (app-threads.js).
  const protoButton = (id, { label = 'Ask for prototypes' } = {}) => `<button type="button" class="attach proto-ask" data-proto="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}">${EYE}</button>`;
  // The thread's fire, the eye's twin for a grill.
  const grillButton = (id) => `<button type="button" class="attach proto-ask" data-grill="${esc(id)}" aria-label="Ask for a grill" title="Ask for a grill">${FIRE}</button>`;
  // The thread's image, asking for a visual: a page an agent draws to answer in the thread (app-threads.js;
  // docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md).
  const visualButton = (id) => `<button type="button" class="attach proto-ask" data-visual="${esc(id)}" aria-label="Ask for a visual" title="Ask for a visual">${icon(IMAGE_PATHS)}</button>`;
  // docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
  // A thread status line's leading mark, its icon or dot centred in one fixed box so every line's text starts at the
  // same place: a command line's icon by its words (domain.mjs COMMANDS: the request's eye, fire or image, Implement's
  // code brackets, Hold's pause, Resume's play, Done's circled check), Reply's arrow, answers' check, a reopened
  // question's turn-back arrow, a Questions added line's plain question mark, a builder's dot.
  const mini = (body, cls = '') => `<svg class="mark-icon${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const LINK = mini('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>');
  const BLOCKED = mini('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>');
  const CREATED = mini('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8"/><path d="M8 12h8"/>');
  const MARK_ICONS = {
    'Prototype requested': mini('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    'Grill requested': mini('<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/>'),
    'Visual requested': mini(IMAGE_PATHS),
    'Re-ask requested': mini('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
    visual: mini(IMAGE_PATHS),
    'ask-link': mini('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
    move: mini('<path d="M3 7h14"/><path d="m13 3 4 4-4 4"/><path d="M21 17H7"/><path d="m11 13-4 4 4 4"/>'),
    'Implementation requested': mini('<path d="m8 6-6 6 6 6"/><path d="m16 6 6 6-6 6"/>'),
    'Marked as discussing': mini('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    'Marked as staging': mini('<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>'),
    'Marked as ready': mini('<path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/>'),
    Held: mini('<path d="M9 5v14"/><path d="M15 5v14"/>'),
    Resumed: mini('<path d="M7 4v16l13-8z"/>'),
    // The board's status lines (board/hub-lines.mjs): a block's circle with a bar, a fault's warning triangle.
    Blocked: BLOCKED, 'Blocked by': BLOCKED, Unblocks: BLOCKED,
    Fault: mini('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    'Related to': LINK, 'Unrelated from': LINK, 'Follow-up': LINK, 'Follow-up of': LINK, 'Created ticket': CREATED, 'Created from': CREATED,
    'Marked done': mini('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
    Reopened: mini('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    Reply: mini('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>'),
    Implement: mini('<path d="m8 6-6 6 6 6"/><path d="m16 6 6 6-6 6"/>'),
    'answers submitted': mini('<path d="M20 6 9 17l-5-5"/>'),
    'question reopened': mini('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
    'judgment calls': mini('<path d="m9 6 6 6-6 6"/>'),
    'status lines': mini('<path d="m9 6 6 6-6 6"/>'),
    questions: mini('<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>', ' big'),
  };
  const mark = (inner = '') => `<span class="mark" aria-hidden="true">${inner}</span>`;
  const statusMark = (words) => mark(MARK_ICONS[words] || '');
  const PENCIL = icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
  const BUMP = icon('<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>');
  // Deletes or edits an ask in the New strip; app-asks.js handles [data-withdraw] and [data-edit].
  const withdrawButton = (id) => `<button class="ghost icon" data-withdraw="${esc(id)}" aria-label="Delete" title="Delete">${TRASH}</button>`;
  const editButton = (id) => `<button class="ghost icon" data-edit="${esc(id)}" aria-label="Edit" title="Edit">${PENCIL}</button>`;
  // A card's bump: app-cards.js sends card-bump {key} with no confirm, and on a bumped card, where it is filled orange,
  // card-unbump {key} (docs/adr/2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md,
  // docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md).
  const cardBumpButton = (key, bumped) => (bumped
    ? `<button class="ghost icon bumped" data-card-bump="${esc(key)}" data-bumped aria-pressed="true" aria-label="Unbump" title="Bumped. Tap to unbump">${BUMP}</button>`
    : `<button class="ghost icon" data-card-bump="${esc(key)}" aria-pressed="false" aria-label="Bump to top" title="Bump to top">${BUMP}</button>`);
  const workingLine = '<span class="thinking"><span class="working-dot" aria-hidden="true"></span>thinking…</span>';
  // Every paused status, whatever its place, is this one class (style.css .paused); BoardUI.usagePause is set by the
  // board view (app.js) to read the hub's usage pause.
  const PAUSED = '<span class="paused">paused</span>';
  const isPaused = () => BoardUI.usagePause?.()?.state === 'paused';
  // The orchestrator's "thinking" while its usage allows, else paused.
  const thinkingLine = () => (isPaused() ? PAUSED : workingLine);
  // html is markup the caller has escaped; href, title and attrs values are escaped here.
  const BADGE_TONES = Object.freeze(['quiet', 'normal', 'notice', 'danger', 'ready', 'merged']);
  function badge(tone, html, { href, title, button = false, attrs = {} } = {}) {
    if (!BADGE_TONES.includes(tone)) throw new Error(`unknown badge tone: ${tone}`);
    const extra = Object.entries({ href, title, ...attrs }).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const tag = button ? 'button' : href == null ? 'span' : 'a';
    return `<${tag} class="chip tone-${tone}"${extra}>${html}</${tag}>`;
  }
  // A composer's files before sending: {id, name, type, preview, status: uploading|done|error, progress (0–1), error}.
  // An errored chip retries on click, except "Over 20 MB", which a retry can't change.
  const pendingFiles = (list) => list.map((p) => {
    const retry = p.status === 'error' && p.error !== 'Over 20 MB';
    const title = retry ? `${p.name}: tap to retry` : p.status === 'error' ? `${p.name}: a retry can't succeed, remove it` : p.name;
    return `<span class="pfile ${esc(p.status)}${retry ? ' retry' : ''}" title="${esc(title)}"${retry ? ` data-retry="${esc(p.id)}"` : ''}>
      ${isImage(p) && p.preview ? `<img src="${esc(p.preview)}" alt="${esc(p.name)}">` : `<span class="pname">${esc(p.name)}</span>`}
      ${p.status === 'uploading' ? `<span class="pbar" role="progressbar" aria-label="Uploading ${esc(p.name)}" aria-valuenow="${Math.round((p.progress || 0) * 100)}"><span style="width:${Math.max(4, Math.round((p.progress || 0) * 100))}%"></span></span>` : ''}
      ${p.status === 'error' ? `<span class="perr">${esc(p.error || 'Upload failed')}${retry ? ' · tap to retry' : ''}</span>` : ''}
      <button type="button" class="unattach" data-unattach="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button></span>`;
  }).join('');

  // Replacing innerHTML would close every <details> inside, collapsing what the reader had open, and replace the field
  // being typed in, dropping its text, cursor and focus, and on iOS the keyboard. So setHTML patches el in place: a
  // node stays when the new markup has one of its tag at its place, and an element with a key (keyOf) stays wherever
  // under el it was, so a card that moves lanes keeps its open thread. A textarea keeps what was typed in it, and an
  // element matching opts.keep stays as it is, for markup another part paints. The focused field keeps its focus when
  // its card moves (focusSafe). setHTML skips an unchanged rebuild, and reopens each <details> the reader left open,
  // matched by its owning [data-key] and summary text (a card itself by its key alone, its summary text changing as it ages). Open state is tracked page-wide, so content filled in after a
  // parent rebuild reopens too.
  const lastHtml = new WeakMap();
  const openDetails = new Set();
  const detailsKey = (d) => d.matches('[data-key]') ? d.dataset.key : `${(d.closest('[data-key]') || {}).dataset?.key || ''}|${(d.querySelector(':scope > summary')?.textContent || '').trim()}`;
  globalThis.document?.addEventListener('toggle', (ev) => {
    if (ev.target.tagName !== 'DETAILS') return;
    if (ev.target.open) openDetails.add(detailsKey(ev.target)); else openDetails.delete(detailsKey(ev.target));
  }, true);
  const KEYS = ['id', 'data-thread', 'data-event', 'data-edit-form', 'data-lane', 'data-fold', 'data-new'];
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
    for (const w of waits) { const b = waitingButton(w); if (b && !b.classList.contains(w.mark)) markWaiting(b, w); }
    return true;
  }

  // Closes <details> d at once: its toggle event comes a task later, and a setHTML before it would reopen it.
  function closeDetails(d) {
    openDetails.delete(detailsKey(d));
    d.open = false;
  }

  // A tap that saves something waits for the server (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md,
  // docs/adr/2026-11-03-1915-every-pending-control-waits-in-one-style.md): waitOn(control, promise, {group}) disables
  // control until promise settles and marks it tap-waiting and aria-busy. style.css button[aria-busy="true"] keeps a
  // button's colours and width and shows a spinner in its text colour in place of its content, or pulses a bump icon
  // orange. A toggle, select or field keeps its face, with a spinner beside it: after its caption in a .tk-field, else
  // just before it. group: the other choices of the same setting, disabled (tap-blocked) with no spinner meanwhile.
  // A repaint meanwhile (setHTML) patches each back to its markup, so setHTML marks it again, found by its id and data
  // attributes when the repaint replaced it. Settling restores the disabled and aria-busy its latest markup had. → promise
  // Work that outlives its request (a restart, an update, a merge) draws its button with BUSY in its markup until the
  // state the page draws from says the work is done.
  const BUSY = ' disabled aria-busy="true"';
  const waits = new Set();
  function markWaiting(b, w) {
    w.el = b;
    w.disabled = b.disabled;
    w.busy = b.getAttribute('aria-busy');
    b.disabled = true;
    b.classList.add(w.mark);
    if (w.mark !== 'tap-waiting') return;
    b.setAttribute('aria-busy', 'true');
    if (b.tagName === 'BUTTON') return;
    w.spin?.remove();
    w.spin = document.createElement('span');
    w.spin.setAttribute('class', 'try-spin tap-beside');
    w.spin.setAttribute('aria-hidden', 'true');
    const caption = b.closest('.tk-field')?.firstElementChild;
    if (caption && caption !== b) caption.appendChild(w.spin);
    else b.before(w.spin);
  }
  const waitingButton = (w) => (w.el.isConnected && w.el.matches(w.selector) ? w.el
    : w.named ? document.body.querySelector(w.selector) : null);
  function waitFor(el, mark) {
    const named = [...el.attributes].filter(({ name }) => name === 'id' || name.startsWith('data-'));
    const w = { mark, selector: el.tagName.toLowerCase() + named.map(({ name, value }) => (value ? `[${name}="${CSS.escape(value)}"]` : `[${name}]`)).join(''), named: named.length > 0 };
    markWaiting(el, w);
    waits.add(w);
    return w;
  }
  function waitOn(control, promise, { group = [] } = {}) {
    const mine = [waitFor(control, 'tap-waiting'), ...[...group].filter((el) => el !== control).map((el) => waitFor(el, 'tap-blocked'))];
    const done = () => {
      for (const w of mine) {
        waits.delete(w);
        w.spin?.remove();
        // setHTML keeps w.el the node it last marked; one a plain innerHTML replaced is gone with its mark.
        const b = w.el;
        if (!b.classList.contains(w.mark)) continue;
        b.classList.remove(w.mark);
        if (w.mark === 'tap-waiting') { if (w.busy === null) b.removeAttribute('aria-busy'); else b.setAttribute('aria-busy', w.busy); }
        b.disabled = w.disabled;
      }
    };
    promise.then(done, done);
    return promise;
  }

  // docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md
  // pending.within(work, onLate): resolves when work settles, or after PENDING_LATE_MS calls onLate() and resolves, so
  // waitOn's spinner rests either way. The board's taps wait through it in app.js spinUntil; the Questions page, the
  // permission switches and the Hub page's Restart wait through their own page loads.
  const PENDING_LATE_MS = 60000;
  const pending = {
    within(work, onLate) {
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(() => { onLate(); resolve(); }, PENDING_LATE_MS); });
      return Promise.race([work, late]).finally(() => clearTimeout(timer));
    },
  };

  // Why a board request failed, from what the hub marks on its answer (hub/hub.mjs sendDown, hub/front-door.mjs refuse)
  // (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md). answer is the response, or null when
  // nothing answered or the request timed out; online is navigator.onLine. → {state, line, hint, retries}: the landing's
  // two lines, and whether the board can come back by itself, so the page keeps retrying.
  const BACK = 'This page comes back by itself.';
  const DOWN = {
    restarting: { line: 'Board restarting' },
    stopped: { line: 'Board stopped', hint: 'Nothing answers on its port. Its Claude session has to start it.' },
    removed: { line: 'This board is gone', hint: 'The hub no longer lists it.', retries: false },
    access: { line: 'You no longer have access', hint: 'Ask its owner to share it again.', retries: false },
    erroring: { line: 'Board restarting', hint: 'It answers with errors. Retrying for 30 seconds.' },
    unreachable: { line: 'Board offline', hint: 'The hub, your connection or the host is down. Retrying.' },
  };
  const RESTART_WHY = { code: 'Its code changed.', starting: 'It’s starting.', crashed: 'It stopped, and the hub is starting it again.' };
  function downOf(answer, online = navigator.onLine !== false) {
    const why = online && answer ? answer.headers.get('x-kickflip-down') : null;
    const state = !online || !answer ? 'unreachable'
      : RESTART_WHY[why] ? 'restarting'
        : DOWN[why] ? why
          : answer.headers.get('x-app-shell') ? 'access'
            : why || answer.headers.get('x-kickflip-hub') ? 'erroring' : 'unreachable';
    return { state, retries: true, ...DOWN[state], ...(state === 'restarting' ? { hint: `${RESTART_WHY[why]} ${BACK}` } : {}) };
  }
  // A view's place when it has no copy to show: the kickflip mark and down's two lines, as the no-access page has them.
  const downLanding = (down) => `<div class="down-landing" data-down="${down.state}"><img class="down-landing-mark" src="/_hub/kickflip.png" width="70" height="60" alt="">
<p class="down-landing-line">${esc(down.line)}</p><p class="down-landing-hint">${esc(down.hint)}</p></div>`;
  // The landing for a board that loaded but threw while drawing (docs/adr/2026-11-12-0400-a-board-that-throws-while-drawing-shows-a-landing-with-the-error.md):
  // the error's message, its stack behind Show details, Reload and Copy error (app.js wires them).
  const drawLanding = (err) => `<div class="down-landing" data-down="draw"><img class="down-landing-mark" src="/_hub/kickflip.png" width="70" height="60" alt="">
<p class="down-landing-line">This board couldn't draw</p><p class="down-landing-hint">The board loaded, but it threw while drawing. Your data is fine.</p>
<p class="down-landing-hint"><b>${esc(err?.name || 'Error')}:</b> ${esc(err?.message ?? String(err))}</p>
<div class="down-landing-buttons"><button type="button" data-draw="reload">Reload</button> <button type="button" data-draw="copy">Copy error</button> <button type="button" data-draw="more">Show details</button></div>
<pre class="down-landing-stack" hidden>${esc(err?.stack || '')}</pre></div>`;
  // The line over a side page painted from its copy while the board can't be reached.
  const copyNote = (what, savedAt) => `<p class="note copy-note">Copy of ${esc(what)} as of ${since(savedAt)}. Read only.</p>`;
  // The buttons that send, which a board out of reach holds (style.css .offline): every one greyed and stopped, keeping its
  // label and size. Reading controls, folds, links, Edit and drafts stay live.
  const SENDS = `form button[type="submit"], .actions button, button[data-confirm], button[data-review-answer], button[data-prompt-send], button[data-prompt-choice], button[data-quick], button[data-card-bump], button[data-bump], button[data-withdraw], button[data-grill], button[data-proto], button[data-visual], button[data-plan], button[data-main-pull], button[data-arch-run], button[data-try], button[data-try-kill], button[data-reopen]`;
  // While held(), a tap on one of root's sending buttons, and any form's submit there, Enter's included, goes nowhere, and onHeld
  // tells the tap it is waiting. on is the view's B.on.
  function holdSends(on, root, held, onHeld) {
    const stop = (ev) => {
      if (!held() || (ev.type === 'click' && !ev.target.closest?.(SENDS))) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      onHeld();
    };
    on(root, 'click', stop, true);
    on(root, 'submit', stop, true);
  }

  // While a board restarts, the hub answers its own 502 page, and a request can fail outright. fetchJSON waits that out:
  // on a network error, a 5xx or a body that isn't JSON it calls onWait(waitedMs, down) and retries with a growing backoff,
  // then throws once about limit ms have passed, the error carrying down (downOf). Any other answer resolves
  // {ok, status, body}, a 404's {error} included.
  // tag is the version of the board the page holds: an unchanged board answers 304, which resolves with body null
  // (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md).
  const WAITING = 'Waiting for the board to reconnect';
  const RESTARTING = 'Board restarting…';
  const restartNotice = () => `<span class="muted small restarting">${RESTARTING}</span>`;
  async function fetchJSON(url, { onWait = () => {}, limit = 30000, tag = null, fetch: get = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let waited = 0;
    let delay = 500;
    for (;;) {
      let failure;
      let answer = null;
      try {
        const r = await get(url, { cache: 'no-store', ...(tag ? { headers: { 'if-none-match': `"${tag}"` } } : {}) });
        if (r.status === 304) return { ok: true, status: 304, body: null };
        const body = await r.text().then((t) => JSON.parse(t)).catch(() => undefined);
        if (body !== undefined && r.status < 500) return { ok: r.ok, status: r.status, body };
        answer = r;
        failure = new Error(r.status >= 500 ? `the board answered ${r.status}` : 'the board did not answer with JSON');
      } catch { failure = new Error('Offline. Is the host awake?'); }
      failure.down = downOf(answer);
      if (waited >= limit) throw failure;
      onWait(waited, failure.down);
      await sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, 4000);
    }
  }

  // Whether a click dismisses a modal: it landed on the backdrop element and the press that made it began there too, so a
  // drag that starts inside (selecting text) and ends on the backdrop leaves the modal open.
  let pressedOn = null;
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { pressedOn = e.target; }, true);
  const onBackdrop = (ev, backdrop) => ev.target === backdrop && pressedOn === backdrop;

  globalThis.BoardUI = {
    LINK_ARROW, escText, onBackdrop,
    esc, record, time, ago, lasted, since, clock, etaLine, cardTime, replyBody, setHTML, closeDetails, BUSY, waitOn, pending, fetchJSON, WAITING, RESTARTING, restartNotice, downOf, downLanding, drawLanding, copyNote, SENDS, holdSends,
    attachments, attachButton, dropZone, sendButton, keyedSend, pendingFiles, protoButton, grillButton, visualButton, mark, statusMark, MARK_ICONS, withdrawButton, editButton, cardBumpButton, workingLine, thinkingLine, isPaused, PAUSED, BADGE_TONES, badge,
  };
})();
