// Renderers the board's pages share, and the base the other ui-*.js files add to BoardUI. Each returns an HTML
// string and touches no DOM or storage: ui.test.mjs runs these files in node:vm, where neither exists. Load this first.
// fetchJSON is the side pages' one way to read the board's API.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const record = (records, key) => (Object.hasOwn(records || {}, key) ? records[key] : undefined);
  // A time as "2:28 pm" today and "11/13, 2:28 pm" on another day; `now` is injectable.
  const time = (iso, now = new Date()) => {
    const d = new Date(iso);
    const at = clock(d);
    return d.toDateString() === now.toDateString() ? at : `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })}, ${at}`;
  };
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
  // A composer's text box with its attach button inside at the bottom right, which attach.js outlines
  // with Drop to attach while files are dragged over the composer. Its Paste chip sits at the bottom left, and style.css
  // shows it only while the box is empty (its placeholder showing); attach.js pastes the clipboard on a tap.
  const dropZone = (textarea) => `<div class="dz">${textarea}<button type="button" class="paste-chip" data-paste>Paste</button>${attachButton()}<div class="dz-hint" aria-hidden="true">Drop to attach</div></div>`;
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
  // A page's Open alone ↗ link: the page by itself, with no shell around it (?alone=1, hub/shell.mjs pageOf), for the
  // frame view (view-frame.js) and a card page in the reader sheet (app-reader.js).
  const aloneHref = (url) => {
    const u = new URL(url, location.href);
    u.searchParams.set('alone', '1');
    return u.pathname + u.search + u.hash;
  };
  // Escaped text with each ↗ (and a trailing U+FE0E) drawn as LINK_ARROW; for owner-facing text, never an attribute.
  const escText = (s) => esc(s).replace(/\u2197\uFE0E?/g, LINK_ARROW);
  const TRASH = icon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
  // docs/adr/2026-11-16-0630-the-request-row-is-outlined-buttons-spread-with-key-hints.md
  // The request row's words: Prototype, Grill, Visual and Review, small outlined
  // buttons spread evenly, each with its Alt+letter (⌥ on a Mac) as a faint hint at the right where style.css shows
  // key hints. A thread's reply box, each open question and the New task box draw the row through requestRow.
  const REQUEST_KEYS = { KeyP: 'data-proto', KeyG: 'data-grill', KeyV: 'data-visual', KeyR: 'data-review' };
  const ALT = MAC ? '⌥' : 'Alt+';
  const requestButton = (attr, word, letter, label, extra = '') => `<button type="button" class="req" ${attr}${extra} aria-label="${esc(label)}" title="${esc(label)}"><span class="req-word">${word}</span><span class="key-hint" aria-hidden="true">${ALT}${letter}</span></button>`;
  // A question's Prototype asks for one instead of the pick; a thread's and the New task's ask for prototypes.
  const protoButton = (id, { label = 'Ask for prototypes' } = {}) => requestButton(`data-proto="${esc(id)}"`, 'Prototype', 'P', label);
  const grillButton = (id) => requestButton(`data-grill="${esc(id)}"`, 'Grill', 'G', 'Ask for a grill');
  // The visual: a page an agent draws to answer in the thread (app-threads.js;
  // docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md).
  const visualButton = (id) => requestButton(`data-visual="${esc(id)}"`, 'Visual', 'V', 'Ask for a visual');
  // Review sends what typing /review does (docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md).
  const reviewButton = (id) => requestButton(`data-review="${esc(id)}"`, 'Review', 'R', 'Ask for a review');
  // docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md
  // The request row, one helper for a thread's reply box, each open question and the New
  // task box: only the words, spread across; the attach icon is inside the text box (dropZone).
  const requestRow = (id, { protoLabel } = {}) =>
    `<span class="request-row">${protoButton(id, protoLabel ? { label: protoLabel } : {}) + grillButton(id) + visualButton(id) + reviewButton(id)}</span>`;
  // The request words belong to a card in New or Todo; from In Progress on its rows keep only attach and send. A
  // card the board hasn't read yet shows them.
  const requestShown = (item) => !item?.lane || item.isNew || item.lane === 'todo';
  // The request button an Alt+letter keydown presses within scope, or null.
  const keyedRequest = (ev, scope) => {
    const attr = ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.isComposing ? REQUEST_KEYS[ev.code] : null;
    const button = attr && scope?.querySelector(`button[${attr}]`);
    return button && !button.disabled ? button : null;
  };
  // The request a row's icon asks for: prototype, grill, visual or review.
  const requestOf = (button) => (button.hasAttribute('data-proto') ? 'prototype' : button.hasAttribute('data-grill') ? 'grill' : button.hasAttribute('data-review') ? 'review' : 'visual');
  // A /prototype, /grill, /visual or /review word in a message, the last one winning, and the message without it: {flag, text}.
  // docs/adr/2026-11-19-0930-review-sits-in-every-request-row.md
  const SLASH = /(^|\s)\/(grill|prototype|visual|review)(?=\s|$)/g;
  const slashOf = (value) => ({ flag: [...value.matchAll(SLASH)].pop()?.[2] ?? null, text: value.replace(SLASH, '$1').replace(/ {2,}/g, ' ').trim() });
  // docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
  // A thread status line's leading mark, its icon or dot centred in one fixed box so every line's text starts at the
  // same place: a command line's icon by its words (domain.mjs COMMANDS: the request's eye, fire or image, Implement's
  // code brackets, Block's barred circle, Unblock's play, Done's circled check), Reply's arrow, answers' check, a Questions added line's plain question mark, a builder's dot.
  // Each is ui-icon-text.js's shape in the line's own colour (iconText 'current').
  const shape = (name) => globalThis.BoardUI.iconText(name, 'current', '');
  const MARK_ICONS = {
    'Prototype requested': shape('eye'),
    'Grill requested': shape('flame'),
    'Visual requested': shape('image'),
    'Review requested': shape('search'),
    'Prototype started': shape('eye'),
    'Grill started': shape('flame'),
    'Visual started': shape('image'),
    'Review started': shape('search'),
    'Re-ask requested': shape('retry'),
    visual: shape('image'),
    'ask-link': shape('arrow'),
    move: shape('move'),
    'Marked as discussing': shape('chat'), 'Cancelled Implement': shape('chat'),
    // The board's hub lines (board/hub-lines.mjs BUILD) still draw as "Implementation requested", with staging's icon.
    'Marked as staged': shape('code'),
    'Implementation requested': shape('code'),
    'Marked as ready': shape('flag'),
    Held: shape('pause'),
    Resumed: shape('play'), Unblocked: shape('play'),
    // The board's status lines (board/hub-lines.mjs): a block's circle with a bar, a fault's warning triangle.
    Blocked: shape('blocked'), 'Blocked by': shape('blocked'), Unblocks: shape('blocked'),
    Fault: shape('warn'),
    'Related to': shape('link'), 'Unrelated from': shape('link'), 'Follow-up': shape('link'), 'Follow-up of': shape('link'), 'Created ticket': shape('created'), 'Created from': shape('created'),
    'Marked done': shape('circle-check'),
    Reopened: shape('reopen'),
    // The record of a tap that writes no line of its own otherwise (domain.mjs COMMANDS).
    'Moved to the top': shape('move'), Unbumped: shape('move'), 'Merge requested': shape('move'),
    'Serve started': shape('play'), 'Serve killed': shape('pause'),
    'Ran the script': shape('play'), 'Declined the script': shape('x'),
    Tagged: shape('tag'), Untagged: shape('tag'),
    Reply: shape('reply'),
    Implement: shape('code'),
    'answers submitted': shape('check'),
    'judgment calls': shape('chevron'),
    'status lines': shape('chevron'),
    questions: shape('question'),
  };
  const mark = (inner = '') => `<span class="mark" aria-hidden="true">${inner}</span>`;
  const statusMark = (words) => mark(MARK_ICONS[words] || '');
  const BUMP = icon('<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>');
  // Deletes an ask in the New strip; app-asks.js handles [data-withdraw].
  const withdrawButton = (id) => `<button class="ghost icon" data-withdraw="${esc(id)}" aria-label="Delete" title="Delete">${TRASH}</button>`;
  // A card's Bump, an item of its "…" menu (ui-cards.js cardMenu): app-cards.js sends card-bump {key} with no confirm,
  // and on a bumped card, whose "…" is filled orange, Unbump sends card-unbump {key}
  // (docs/adr/2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md,
  // docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md,
  // docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md).
  const cardBumpItem = (key, bumped, sending = false) => `<button type="button" role="menuitem" data-card-bump="${esc(key)}"${bumped ? ' data-bumped' : ''}${sending ? SENDING : ''}>${BUMP}<span>${bumped ? 'Unbump' : 'Bump'}</span></button>`;
  // A working dot beats on every pulse's one clock; an agent's dot is still. Both take their line's colour.
  const WORKING_DOT = globalThis.BoardUI.iconText('pulse', 'current', '');
  const AGENT_DOT = globalThis.BoardUI.iconText('dot', 'current', '');
  const workingLine = `<span class="thinking">${WORKING_DOT}thinking…</span>`;
  // docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md
  // The count after a working word is liveFor (ui-icon-text.js). Each element drawn with it holds the time it counts
  // from (data-since) and its word (data-word), and app-header.js repaints their text each half-minute, so a repaint
  // of the board is no part of the count.
  const withCount = (word, since, now) => [word, globalThis.BoardUI.liveFor(since, now)].filter(Boolean).join(' ');
  const thinkingFor = (since, now) => withCount('thinking…', since, now);
  const counted = (cls, word, since, dot = WORKING_DOT) => `<span class="${cls}" data-since="${esc(since)}" data-word="${word}">${dot}${withCount(word, since)}</span>`;
  const recount = (root, now = Date.now()) => {
    for (const el of root.querySelectorAll('[data-since][data-word]')) {
      const dot = el.firstElementChild;
      el.replaceChildren(...(dot ? [dot] : []), withCount(el.dataset.word, el.dataset.since, now));
    }
  };
  // Every paused status, whatever its place, is this one class (style.css .paused); the server says what is held.
  const PAUSED = '<span class="paused">paused</span>';
  const thinkingLine = (since) => (since ? counted('thinking', 'thinking…', since) : workingLine);
  // html is markup the caller has escaped; href, title and attrs values are escaped here.
  const BADGE_TONES = Object.freeze(['quiet', 'normal', 'notice', 'danger', 'ready', 'merged']);
  function badge(tone, html, { href, title, button = false, attrs = {} } = {}) {
    if (!BADGE_TONES.includes(tone)) throw new Error(`unknown badge tone: ${tone}`);
    const extra = Object.entries({ href, title, ...attrs }).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const tag = button ? 'button' : href == null ? 'span' : 'a';
    return `<${tag} class="chip tone-${tone}"${extra}>${html}</${tag}>`;
  }
  // A composer's files before sending (attach.js): {id, name, type, preview, status: uploading|done|error, progress (0–1),
  // error, final}. An errored chip retries on click, except a final one ("Over 20 MB", or lost in a reload), which a
  // retry can't change.
  const uploadBar = (p) => (p.status === 'uploading' ? `<span class="pbar" role="progressbar" aria-label="Uploading ${esc(p.name)}" aria-valuenow="${Math.round((p.progress || 0) * 100)}"><span style="width:${Math.max(4, Math.round((p.progress || 0) * 100))}%"></span></span>` : '');
  const unattach = (p) => `<button type="button" class="unattach" data-unattach="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button>`;
  const pendingFiles = (list) => list.map((p) => {
    const retry = p.status === 'error' && !p.final;
    const title = retry ? `${p.name}: tap to retry` : p.status === 'error' ? `${p.name}: a retry can't succeed, remove it` : p.name;
    return `<span class="pfile ${esc(p.status)}${retry ? ' retry' : ''}" title="${esc(title)}"${retry ? ` data-retry="${esc(p.id)}"` : ''}>
      ${isImage(p) && p.preview ? `<img src="${esc(p.preview)}" alt="${esc(p.name)}">` : `<span class="pname">${esc(p.name)}</span>`}
      ${uploadBar(p)}
      ${p.status === 'error' ? `<span class="perr">${esc(p.error || 'Upload failed')}${retry ? ' · tap to retry' : ''}</span>` : ''}
      ${unattach(p)}</span>`;
  }).join('');
  // docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md
  // A New task's files on its strip row while the page sends it (ui-cards.js newEntry), the same list as pendingFiles,
  // drawn as attachments draws sent files: a thumbnail for an image, a chip for another file. One uploading is dimmed
  // under its progress bar; one that failed is marked with why and an X to remove it. The row's one Retry re-uploads
  // what failed (app-threads.js), so a tile has no retry of its own.
  const uploadTiles = (list) => `<div class="files">${list.map((p) => {
    const failed = p.status === 'error' ? `<span class="perr">${esc(p.error || 'Upload failed')}</span>${unattach(p)}` : '';
    const title = p.status === 'error' ? `${p.name}: ${p.error || 'Upload failed'}` : p.name;
    return isImage(p) && p.preview
      ? `<span class="file-thumb ${esc(p.status)}" title="${esc(title)}"><img src="${esc(p.preview)}" alt="${esc(p.name)}">${uploadBar(p)}${failed}</span>`
      : `<span class="file-link ${esc(p.status)}" title="${esc(title)}">${esc(p.name)}${uploadBar(p)}${failed}</span>`;
  }).join('')}</div>`;
  // A sent message's files, or, while the page still sends it (an outbox entry's uploads {box, list}, or a list of them
  // for an answer set's boxes), each box's tiles inside the [data-uploads] wrapper attach.js's X reads.
  const sentFiles = (files, uploads) => (uploads ? [].concat(uploads).map((u) => `<div data-uploads="${esc(u.box)}">${uploadTiles(u.list)}</div>`).join('') : attachments(files));

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
  const KEYS = ['id', 'data-thread', 'data-event','data-lane', 'data-fold', 'data-new'];
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
  // docs/adr/2026-11-03-1915-every-pending-control-waits-in-one-style.md): waitOn(control, promise, {group, quiet}) disables
  // control until promise settles and marks it tap-waiting and aria-busy. style.css button[aria-busy="true"] keeps a
  // button's colours and width and shows a spinner in its text colour in place of its content. A toggle, select or
  // field keeps its face, with a spinner beside it: after its caption in a .tk-field, else just before it. group: the
  // other choices of the same setting, disabled (tap-blocked) with no spinner meanwhile. quiet: a card tap, whose thread
  // line carries the spinner, so control is only disabled (tap-blocked), as SENDING draws it.
  // A repaint meanwhile (setHTML) patches each back to its markup, so setHTML marks it again, found by its id and data
  // attributes when the repaint replaced it. Settling restores the disabled and aria-busy its latest markup had. → promise
  // Work that outlives its request (a restart, an update, a merge) draws its button with BUSY in its markup until the
  // state the page draws from says the work is done.
  const BUSY = ' disabled aria-busy="true"';
  // docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md: a card button whose tap is
  // sending, or whose work runs on (a Merge, a Serve), is only disabled, dimmed as any disabled button (style.css), with
  // no spinner: the tap's thread line carries its sending… and the one spinner. waitOn's quiet does the same for a tap
  // that waits on its own request. Controls with no thread (the header, Settings, the hub) keep BUSY.
  const SENDING = ' disabled';
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
  function waitOn(control, promise, { group = [], quiet = false } = {}) {
    const mine = [waitFor(control, quiet ? 'tap-blocked' : 'tap-waiting'), ...[...group].filter((el) => el !== control).map((el) => waitFor(el, 'tap-blocked'))];
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
    access: { line: 'You no longer have access', hint: 'Only its owner’s Tailscale account opens it.', retries: false },
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
  // docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md
  // An outbox send (app-threads.js flush, app-questions-sheet.js flush, view-hub.js): send(signal) runs with an abort
  // signal and gives up after SEND_LIMIT_MS, so a tap reads sending… at most that long. → send's promise, or a
  // rejection marked timedOut. A send that got no answer at all carries unreachable (claude.js send).
  const SEND_LIMIT_MS = 15000;
  function sendWithin(send) {
    const abort = new AbortController();
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(Object.assign(new Error('No answer in 15 s'), { timedOut: true })); }, SEND_LIMIT_MS);
    });
    return Promise.race([send(abort.signal), late]).finally(() => clearTimeout(timer));
  }

  // While a board restarts, the hub answers its own 502 page, and a request can fail outright. fetchJSON waits that out:
  // on a network error, a 5xx or a body that isn't JSON it calls onWait(waitedMs, down) and retries with a growing backoff,
  // then throws once about limit ms have passed, the error carrying down (downOf). Any other answer resolves
  // {ok, status, body}, a 404's {error} included.
  // tag is the version of the board the page holds: an unchanged board answers 304, which resolves with body null
  // (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md).
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
  // Whether a click's point is outside the modal's own box. A bottom sheet is its own backdrop target, so a tap on its
  // padding reads as a backdrop click; only the dim area around the box counts as one.
  const outsideBox = (ev, box) => { const r = box.getBoundingClientRect(); return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom; };

  // docs/adr/2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md
  // The sheet stack. Every sheet opens through openSheet and closes through closeSheet or its own close(); one opened
  // while another is open stacks on it, and the one beneath stays open where it was. A sheet that shows pages (the
  // reader) stacks a page on itself with pushPage: a layer of its own, the sheet on top, which popPage or the sheet
  // closing takes off, the sheet showing its page beneath and going back under any sheet stacked on it before.
  // No layer reads or writes the browser's history or the address: Back leaves the board as from any page. A layer that
  // closes, however it closes, gives the layer beneath, back on top, a sheet-return event.
  // layers: bottom first, a sheet's own {sheet, modal, shut}, shut its close listener while in the stack, and each page
  // it stacked {sheet, page: true}.
  const layers = [];
  const isTopSheet = (sheet) => layers.at(-1)?.sheet === sheet;
  // The open sheets, bottom first, each once.
  const openSheets = () => layers.map((l) => l.sheet).filter((sheet, i, all) => sheet.open && all.indexOf(sheet) === i);
  // The stacked sheets as they show, bottom first, and those showing again in their place (restack), whose close is
  // no leaving.
  let shown = [];
  const moving = new Set();
  // Each sheet shows at its topmost layer: from the first one out of that order, each shows again, in order, its
  // scroll kept. A non-modal sheet stacks by its --layer (style.css .reader-sheet).
  function restack() {
    const order = layers.map((l) => l.sheet).filter((sheet, i, all) => all.lastIndexOf(sheet) === i);
    shown = shown.filter((sheet) => order.includes(sheet));
    let kept = -1;
    let from = order.length;
    for (const [i, sheet] of order.entries()) {
      const at = shown.indexOf(sheet);
      if (at <= kept || !sheet.open) { from = i; break; }
      kept = at;
    }
    for (const sheet of order.slice(from)) {
      const scrolled = [sheet, ...sheet.querySelectorAll('*')].filter((el) => el.scrollTop).map((el) => [el, el.scrollTop]);
      if (sheet.open) { moving.add(sheet); sheet.close(); moving.delete(sheet); }
      if (layers.find((l) => l.sheet === sheet && !l.page).modal) sheet.showModal(); else sheet.show();
      for (const [el, top] of scrolled) el.scrollTop = top;
    }
    order.forEach((sheet, i) => sheet.style.setProperty('--layer', String(i)));
    shown = order;
    focusTop();
  }
  // The top sheet holds the focus: its autofocus field, else the sheet itself, so the keys go to it. Focus already inside
  // it stays.
  function focusTop() {
    const top = layers.at(-1)?.sheet;
    if (!top?.open || top.contains(document.activeElement)) return;
    const target = top.querySelector('[autofocus]');
    if (target) target.focus({ preventScroll: true });
    else { top.tabIndex = -1; top.focus({ preventScroll: true }); }
  }
  // The one Escape for the stack: it closes the top sheet by that sheet's own cancel, which every sheet's own close path
  // answers, and else closes it through closeSheet. A dialog outside the stack (a confirm above it) or an open popup has its own; focus left in a lower sheet still closes the top.
  if (typeof document !== 'undefined') document.addEventListener('keydown', (ev) => {
    const top = layers.at(-1)?.sheet;
    if (ev.key !== 'Escape' || !top?.open) return;
    const dialog = ev.target?.closest?.('dialog');
    if (dialog && !layers.some((l) => l.sheet === dialog)) return;
    if (document.querySelector(':popover-open')) return;
    ev.preventDefault();
    if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) closeSheet(top, (ms, fn) => setTimeout(fn, ms));
  }, true);
  // The layer at, out of the stack.
  function unstack(at) {
    const [layer] = layers.splice(at, 1);
    if (layer.shut) layer.sheet.removeEventListener('close', layer.shut);
    return layer;
  }
  // The top sheet after the stack changed, told when it is another than before.
  function returnTo(was) {
    const top = layers.at(-1)?.sheet;
    if (top && top !== was) top.dispatchEvent(new Event('sheet-return'));
  }
  // The sheet and its pages out of the stack.
  function leaveLayer(sheet) {
    if (!layers.some((l) => l.sheet === sheet)) return;
    const was = layers.at(-1).sheet;
    for (let at = layers.length - 1; at >= 0; at--) if (layers[at].sheet === sheet) unstack(at);
    restack();
    returnTo(was);
  }
  // A page the sheet shows over the one it showed: a layer of its own, the sheet on top.
  function pushPage(sheet) {
    layers.push({ sheet, page: true });
    restack();
  }
  // The sheet's top page out of the stack; the sheet shows the page beneath (its caller's part).
  function popPage(sheet) {
    const was = layers.at(-1).sheet;
    unstack(layers.findLastIndex((l) => l.sheet === sheet && l.page));
    restack();
    returnTo(was);
  }

  // A sheet closes by playing its entry backwards (style.css .closing): 180 ms, then it closes and done runs. Reduced
  // motion closes at once. It leaves the stack as the close starts. cutClose ends one in progress so the sheet can open
  // again.
  // later is the view's own timer (B.later), which an unmount clears.
  function closeSheet(sheet, later, done = () => {}) {
    if (!sheet.open || sheet.classList.contains('closing')) return;
    leaveLayer(sheet);
    if (globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches) { sheet.close(); done(); return; }
    sheet.classList.add('closing');
    later(180, () => {
      if (!sheet.classList.contains('closing')) return;
      sheet.classList.remove('closing');
      sheet.close();
      done();
    }, 180);
  }
  // The one way a sheet opens: one that isn't open yet shows (modal unless said otherwise) on top of every open sheet,
  // with its body and every scroller inside it at the top; one open on top, or on its way out, is left as it is, scroll
  // included; one open under another comes back on top, at its top.
  function openSheet(sheet, { modal = true } = {}) {
    const at = layers.findIndex((l) => l.sheet === sheet && !l.page);
    if (sheet.open && (at === -1 || isTopSheet(sheet))) return;
    if (at >= 0) unstack(at);
    // A sheet shut by its own close(), a swipe or a view's unmount, leaves the stack too; one shown again since stays.
    const layer = { sheet, modal, shut: () => { if (!sheet.open && !moving.has(sheet)) leaveLayer(sheet); } };
    sheet.addEventListener('close', layer.shut);
    layers.push(layer);
    restack();
    for (const el of [sheet, ...sheet.querySelectorAll('*')]) if (el.scrollTop) el.scrollTop = 0;
  }
  function cutClose(sheet) {
    if (!sheet.classList.contains('closing')) return;
    sheet.classList.remove('closing');
    sheet.close();
  }

  // Swiping a sheet down drags it to dismiss (docs/adr/2026-11-14-1700-swiping-a-sheet-down-drags-it-to-dismiss.md).
  // A release past a third of the sheet's height, or a flick, counts as Escape: the sheet's own cancel handler runs.
  const SWIPE = { share: 0.3, flick: 0.6, minFlick: 24, slop: 8 };
  const swipeVerdict = (dy, height, ms) => (dy > height * SWIPE.share || (dy > SWIPE.minFlick && dy / Math.max(ms, 1) > SWIPE.flick) ? 'dismiss' : 'back');
  const SWIPE_TEXT_BOX = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  // A drag may start on the sheet's header, or anywhere once every scroller between the finger and the sheet is at its top.
  const swipeMayStart = (target, sheet) => {
    if (target.closest('.sheet-head, .settings-head')) return true;
    if (target.closest(SWIPE_TEXT_BOX)) return false;
    // A finger in a same-origin frame walks up the frame's page, then on from the frame element in the sheet.
    for (let el = target; el && el !== sheet.parentElement; el = el.parentElement || el.ownerDocument?.defaultView?.frameElement) if (el.scrollTop > 0) return false;
    // The board behind the sheet scrolls on its own: only a frame's page, a document other than the sheet's, counts.
    if (target.ownerDocument !== sheet.ownerDocument && target.ownerDocument?.scrollingElement?.scrollTop > 0) return false;
    return true;
  };
  // Registers the drag once per sheet and returns what removes it, for a sheet that outlives a view's mount.
  const swipers = new WeakMap();
  function swipeToDismiss(sheet) {
    if (swipers.has(sheet)) return swipers.get(sheet);
    let from = null;
    let dragging = false;
    let dy = 0;
    const set = (y, animate) => {
      sheet.style.transition = animate ? 'transform .2s ease-out' : 'none';
      sheet.style.transform = y ? `translateY(${y}px)` : '';
      sheet.style.setProperty('--swipe', String(Math.min(1, y / sheet.offsetHeight)));
    };
    const clear = () => { sheet.style.transition = ''; sheet.style.transform = ''; sheet.style.removeProperty('--swipe'); };
    const start = (e) => {
      // A touch on a scroller scrolled down waits (held) and starts dragging where the scroller reaches its top.
      const mayStart = e.touches.length === 1 && swipeMayStart(e.target, sheet);
      const held = e.touches.length === 1 && !mayStart && !e.target.closest(SWIPE_TEXT_BOX);
      from = mayStart || held ? { x: e.touches[0].screenX, y: e.touches[0].screenY, at: e.timeStamp, held } : null;
      dragging = false;
    };
    const move = (e) => {
      if (!from) return;
      if (from.held) {
        if (!swipeMayStart(e.target, sheet)) return;
        from = { x: e.touches[0].screenX, y: e.touches[0].screenY, at: e.timeStamp, held: false };
      }
      dy = e.touches[0].screenY - from.y; // screenY: a frame moves with the sheet, so its clientY would not hold still
      if (!dragging && dy < SWIPE.slop) {
        if (dy < -SWIPE.slop) from = null;
        // iOS hands the pan to the page at the first touchmove nobody cancels, and then lets no later one be cancelled:
        // a move down claims the touch before the slop moves the sheet (docs/adr/2026-11-22-1400-a-sheets-drag-claims-the-touch-on-its-first-move-down.md).
        else if (dy > 0 && dy >= Math.abs(e.touches[0].screenX - from.x)) e.preventDefault();
        return;
      }
      dragging = true;
      e.preventDefault();
      set(Math.max(0, dy), false);
    };
    const end = (e) => {
      if (!from || !dragging) { from = null; return; }
      const verdict = e.type === 'touchend' ? swipeVerdict(dy, sheet.offsetHeight, e.timeStamp - from.at) : 'back';
      from = null;
      dragging = false;
      if (verdict === 'dismiss') {
        set(dy, false);
        const cancel = new Event('cancel', { cancelable: true });
        sheet.dispatchEvent(cancel);
        if (!cancel.defaultPrevented) { sheet.close(); return; }
        if (!sheet.open || sheet.classList.contains('closing')) return;
      }
      set(0, true);
    };
    const on = [['close', clear], ['touchstart', start, { passive: true }], ['touchmove', move, { passive: false }], ['touchend', end], ['touchcancel', end]];
    for (const [type, fn, opts] of on) sheet.addEventListener(type, fn, opts);
    // A frame's touches stay in its own document: the drag listens there too, and again for each page the frame loads.
    // A frame of another origin throws and keeps the header-only drag.
    const framed = new Set();
    const listenIn = (frame) => {
      let doc;
      try { doc = frame.contentDocument; } catch { return; }
      if (!doc || framed.has(doc)) return;
      framed.add(doc);
      for (const [type, fn, opts] of on.slice(1)) doc.addEventListener(type, fn, opts);
    };
    const onLoad = (e) => { if (e.target.tagName === 'IFRAME') listenIn(e.target); };
    sheet.addEventListener('load', onLoad, true);
    const stop = () => {
      swipers.delete(sheet);
      for (const [type, fn, opts] of on) sheet.removeEventListener(type, fn, opts);
      sheet.removeEventListener('load', onLoad, true);
      for (const doc of framed) for (const [type, fn, opts] of on.slice(1)) doc.removeEventListener(type, fn, opts);
    };
    swipers.set(sheet, stop);
    return stop;
  }

  // After ui-icon-text.js, whose iconText, ICON_SHAPES and ICON_COLOURS stay on BoardUI.
  globalThis.BoardUI = {
    ...globalThis.BoardUI,
    LINK_ARROW, aloneHref, escText, onBackdrop, outsideBox, closeSheet, openSheet, pushPage, popPage, isTopSheet, openSheets, cutClose, swipeToDismiss, swipeVerdict,
    esc, record, time, ago, lasted, since, clock, etaLine, cardTime, replyBody, setHTML, closeDetails, BUSY, SENDING, waitOn, pending, fetchJSON, RESTARTING, restartNotice, downOf, downLanding, drawLanding, copyNote, SEND_LIMIT_MS, sendWithin,
    attachments, attachButton, dropZone, sendButton, keyedSend, pendingFiles, uploadTiles, sentFiles, protoButton, grillButton, visualButton, reviewButton, requestRow, requestShown, keyedRequest, requestOf, slashOf, mark, statusMark, MARK_ICONS, WORKING_DOT, AGENT_DOT, withdrawButton, cardBumpItem, workingLine, thinkingLine, thinkingFor, withCount, counted, recount, PAUSED, BADGE_TONES, badge,
  };
})();
