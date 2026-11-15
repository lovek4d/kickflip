// Waiting on you, /<route>/questions.html#<question or topic id>, a view of the app shell (shell.js): one list of rows,
// one for each thing waiting on the owner, oldest first, every kind in one grammar: the card's key, its title, wrapping
// within its column, and the action owed at the right in its colour, orange, red on a fault or an urgent question, blue
// for a held review (AGENTS.md Colour priority)
// (docs/adr/2026-11-15-1200-waiting-on-you-is-one-list-of-rows-opening-the-questions-sheet.md).
// The rows are what the header's badge counts (BoardUI.queueRows,
// docs/adr/2026-11-14-2330-the-questions-page-is-one-queue-of-what-the-badge-counts.md), with "N need you" over them
// and, with none, "Nothing is waiting on you". A topic with open questions reads Answer N, or Pick a take when all of
// them are prototype picks; a tap reads its action's words (Tap Implement, Hold Run, a fault's reason); a held review,
// keyed PR, reads Review held.
// Tapping a row opens its place, and closing that returns to the list: a topic's row opens the questions sheet
// (app-questions-sheet.js) with that topic's open questions; a Pick a take opens its prototype; a held review opens in
// the Auto Review lane; any other row opens its card's thread. A link to an open question opens its sheet too; a link to a topic marks its row.
// markup({embedded: true}) and ctx.embedded mount it in the board's desktop pane (app-pane.js): no header and no sheet
// of its own, as the board's sheet opens over the pane (ctx.openSheet), and the board's URL and scroll are left alone; it
// holds no board of its own: the lanes' board paints it (ctx.host,
// docs/adr/2026-11-14-2230-the-desktop-pane-shows-the-lanes-board.md). Alone it paints at once from the board's saved
// copy, then asks only for the changes since its number (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md,
// docs/adr/2026-11-14-1500-waiting-on-you-keeps-its-topic-and-paints-from-the-saved-copy.md).
(globalThis.AppViews ||= {}).questions = {
  className: 'view-questions',
  title: () => 'Waiting On You',
  markup: ({ embedded = false } = {}) => `${embedded ? '' : BoardUI.header({ lead: 'logo', title: 'Waiting on you', logoSrc: '/_hub/kickflip.png', controls: false, trail: '<span class="muted small" id="progress"></span>', pages: 'board' })}
<main>
  ${embedded ? '<span class="muted small" id="progress" hidden></span>' : ''}<section id="page"></section>
</main>${embedded ? '' : `
<dialog class="sheet reader-sheet questions-sheet" aria-label="questions">
  <div class="reader-head"><h2>questions</h2><span class="reader-ref"></span><button type="button" class="ghost" data-qs="close" aria-label="Close">✕</button></div>
  <div class="reader-body" tabindex="0"></div>
</dialog>`}`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
    const { $, site } = B;
    const { esc, cardTopics, isPrototype, fetchJSON, downLanding } = BoardUI;
    const hashId = () => { if (ctx.embedded) return ''; const h = location.hash.slice(1); try { return decodeURIComponent(h); } catch { return h; } };

    // The board last landed, whose version the next load and each tap name, so an unchanged board downloads nothing
    // and a changed one comes as a patch (ui-patch.js).
    let board = null;
    // The topic whose row a link or the pane marks, and the rows last drawn, by id, so a row that arrives glows.
    let marked = null;
    let drawnIds = null;
    let shown = '';

    // Embedded, the board is the lanes' (ctx.host, app-pane.js): its load, its send, and take() for each board it lands.
    const send = (kind, data) => (ctx.embedded ? ctx.host.send(kind, data) : site.send(kind, { ...data, ...(board ? { since: board.version } : {}) }));
    const topicOf = (id) => board.owner.find((q) => q.id === id)?.topic ?? (board.ownerTopics.some((t) => t.id === id) ? id : null);

    // A tap's title is its card's ref, a colon, then the card's title.
    const REF = /^(\S+): ([\s\S]*)$/;
    // place: what a row with no sheet opens on the board, a card (item:<key>) or a held review (review:<PR number>).
    function rowOf({ tap, topic }) {
      if (tap?.kind === 'review') return { id: `review:${tap.review}`, key: 'PR', title: tap.title, action: 'Review held', tone: 'info', place: `review:${tap.review}` };
      if (tap) {
        const [, key = '', title = tap.title] = tap.title.match(REF) || [];
        return { id: `tap:${tap.key}`, key, title, action: tap.label || tap.word, tone: tap.fault ? 'danger' : 'notice', place: `item:${tap.key}` };
      }
      const open = board.owner.filter((q) => q.topic === topic.id && q.state === 'open');
      const card = board.items.find((i) => `item:${i.key}` === topic.id);
      const pick = open.length > 0 && open.every((q) => isPrototype(q.url));
      const urgent = open.some((q) => q.urgent);
      return { id: `topic:${topic.id}`, topic: topic.id, key: card ? card.ref : 'Q', title: card ? card.title : topic.title, action: pick ? 'Pick a take' : `Answer ${topic.open}`,
        tone: urgent ? 'danger' : 'notice', urgent, prototype: pick ? open[0].url : null };
    }
    // The badge's rows in the board's order, an urgent question's topic first.
    function rows() {
      const list = BoardUI.queueRows(board.queue, cardTopics(board.ownerTopics, board.items)).map(rowOf);
      return [...list.filter((r) => r.urgent), ...list.filter((r) => !r.urgent)];
    }
    // An arrival slides in with a glow and settles (style.css .arrived).
    const rowHtml = (r, arrived) => `<button type="button" class="wrow${arrived ? ' arrived' : ''}" data-row="${esc(r.id)}"${r.topic && r.topic === marked ? ' aria-current="true"' : ''}><span class="wrow-key">${esc(r.key)}</span><span class="wrow-title">${esc(r.title)}</span><span class="wrow-act tone-${r.tone}">${esc(r.action)}</span></button>`;
    function render() {
      const list = rows();
      $('#page').innerHTML = list.length
        ? `<div class="q-count muted small">${list.length} need you</div><div class="wrows">${list.map((r) => rowHtml(r, drawnIds && !drawnIds.has(r.id))).join('')}</div>`
        : '<div class="q-empty"><b>Nothing is waiting on you</b><p class="muted">Answers, picks and taps land here.</p></div>';
      drawnIds = new Set(list.map((r) => r.id));
    }
    function repaint() {
      const sig = JSON.stringify([marked, rows()]);
      if (sig === shown) return;
      shown = sig;
      render();
    }

    // One load at a time: a load waiting out a board restart would otherwise overlap the next poll's. A load asked for
    // while one runs shares it. → true when the board's answer landed in this view.
    let loading = null;
    let loaded = false;
    const load = () => (ctx.embedded ? ctx.host.reload() : (loading ||= fetchBoard().finally(() => { loading = null; })));
    // While the board can't be reached, the page holds its sending buttons and shows the board's copy here, painted live,
    // or with none and nothing landed the landing for why (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
    let copy = null;
    BoardUI.holdSends(B.on, root, () => root.classList.contains('offline'), () => B.toast(BoardUI.WAITING));
    const out = (down) => {
      root.classList.add('offline');
      copy ||= BoardUI.boardCopy(site.url(''), document.documentElement.dataset.build);
      copy.then((c) => {
        if (!B.alive() || loaded) return;
        if (!c) { $('#page').innerHTML = downLanding(down); return; }
        land(c.board, true);
        repaint();
      });
    };
    async function fetchBoard() {
      try {
        const { body: d } = await fetchJSON(site.url('api/board' + (board ? '?since=' + encodeURIComponent(board.version) : '')), { tag: board?.version, onWait: (ms, down) => out(down), sleep: B.sleep });
        if (!B.alive()) return false;
        root.classList.remove('offline');
        if (d) land(d, !loaded);
        repaint();
        return true;
      } catch (e) {
        out(e.down);
        return false;
      }
    }
    // A board, or a patch from the board held, from a load or a tap's POST. → false for a patch from a board no longer
    // held, which leaves the page as it is. The first opens what the URL names.
    function land(d, first) {
      const next = d.since === undefined ? d : BoardUI.applyPatch(board, d);
      if (!next) return false;
      board = next;
      site.syncBadge();
      loaded = true;
      if (first) openHash();
      return true;
    }

    // Alone, the page's own sheet, made at its first open; embedded, the board's, over the pane.
    let own = null;
    const sheet = () => (own ||= BoardQuestionsSheet(root.querySelector('.questions-sheet'), {
      board: () => board,
      send: async (kind, data) => {
        const sent = await send(kind, data);
        if (B.alive() && !land(sent.board, false)) await load();
        repaint();
        return sent;
      },
      toast: (text) => B.toast(text), on: B.on, atUnmount: B.atUnmount, siteRoot: site.root,
    }));
    const openSheet = (id) => (ctx.embedded ? ctx.openSheet(id) : sheet().open(id));
    // A link to an open question opens its sheet; one to a topic, or to a question already answered, marks its row.
    function openHash() {
      const id = hashId();
      if (!id) return;
      marked = topicOf(id);
      if (board.owner.some((q) => q.id === id && q.state === 'open') && !root.hidden) sheet().open(id);
    }

    // item:<key> is a card, review:<PR number> a held review in the Auto Review lane. Embedded, the board is beside the
    // pane; alone, it is the page before this one.
    // Any other topic, a page's, has no place on the board.
    function openOnBoard(id) {
      if (ctx.embedded) return ctx.openOnBoard(id);
      const [, kind, rest] = id.match(/^(item|review):([\s\S]*)$/) || [];
      if (!kind) return;
      const href = new URL(`./#${kind}=${encodeURIComponent(rest)}`, location.href).href;
      if (!AppShell.open(href)) location.assign(href);
    }
    function openPrototype(url) {
      const href = new URL(url, location.href).href;
      if (!AppShell.open(href)) location.assign(href);
    }
    B.on(root, 'click', (ev) => {
      const button = ev.target.closest?.('[data-row]');
      const r = button && rows().find((x) => x.id === button.dataset.row);
      if (!r) return;
      if (r.prototype) { openPrototype(r.prototype); return; }
      if (!r.topic) { openOnBoard(r.place); return; }
      // Embedded, a card's row also focuses its card on the board, under the sheet.
      if (ctx.embedded) openOnBoard(r.topic);
      if (!openSheet(r.topic)) openOnBoard(r.topic);
    });
    // A link to a question this page's board doesn't have yet (a push tap on a page left in the background) loads the
    // board first. Embedded in the board's pane, the board's hash is not this page's.
    if (!ctx.embedded) B.on(window, 'hashchange', async () => {
      if (!loaded || root.hidden) return;
      const id = hashId();
      if (id && !topicOf(id)) {
        await load();
        if (!B.alive() || hashId() !== id) return;
      }
      openHash();
      repaint();
    });

    // In the board's pane, the shell marks the row of a question's or topic's topic (app-pane.js focusQuestion), and
    // with none or one that's gone marks none. → false before the first load.
    if (ctx.embedded) B.openTopic = (id) => {
      if (!loaded) return false;
      marked = id ? topicOf(id) : null;
      ctx.onTopic?.(marked);
      repaint();
      return true;
    };

    // The saved copy of this build paints first, and the load names its number; with none, the load is the whole board.
    // Embedded, the lanes' board paints here with no fetch: take() draws each board the lanes land, and this the one held.
    if (ctx.embedded) {
      B.take = (d) => { if (d !== board && land(d, !loaded)) repaint(); };
      const held = ctx.host.board();
      if (held) B.take(held);
      return;
    }
    BoardUI.boardCopy(site.url(''), document.documentElement.dataset.build).then((c) => {
      if (B.alive() && c && !board) { land(c.board, true); repaint(); }
    }, () => {}).then(() => { if (B.alive()) load(); });
    B.every(15000, () => { if (!document.hidden) load(); });
    B.on(document, 'visibilitychange', () => { if (!document.hidden) load(); });
  }),
};
