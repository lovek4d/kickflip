// Waiting on you, /<route>/questions.html#<question id>, a view of the app shell (shell.js). A topic's questions show
// on one page with one Send at the bottom, which sends an `owner-answer` event per question answered there; the rest
// stay open for a later visit. Once every answer has sent, a topic with a question still open stays; one with none
// opens the topic whose pill was to its left before the Send, else to its right, and with no topic left that has an
// open question goes back to the board, where the Sent line shows as a toast (BoardUI.sentNotice). An open question
// with `urgent: true` in owner.json shows alone first, and its Send follows the same rule for its topic. A question
// whose url is a prototype page shows its options and a View prototypes link to its full-page viewer
// (docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md).
// Each question's eye sends `prototype-request {key?, question, note, choice}` for that question instead of an answer,
// with its note box as the note and its pick so far as the choice (docs/adr/2026-11-02-1822-each-question-has-its-own-prototype-eye.md).
// The question then reads prototype requested, locked, until its prototype round arrives, and once the request is
// recorded the page moves on as a Send does (docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md,
// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md).
// A question the owner has sent an answer to is resolved: read-only, with a Resolved badge. One that resolves
// while its topic shows stays in place until you leave that topic, by a pill, a link or the move on after the last
// Send; a topic's sent questions otherwise fold under "resolved (N)", which names only the count, above its open ones. A sent question's badge, once confirmed, sends `question-reopen {key?, question}`, and the question
// opens again with its last pick and note for a new Send. Each question is numbered by its place on its card
// (docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md,
// docs/adr/2026-11-06-1100-resolved-questions-fold-away-once-you-leave-their-topic.md).
// A topic or question that arrives while the page shows inserts its pill or card where it belongs, and the counts
// update, with no repaint, so the open topic, its picks, the note being typed and the scroll stay
// (docs/adr/2026-11-05-0408-needs-you-is-a-deck-on-a-phone-and-a-pane-on-a-desktop.md).
// The form holds open questions only: it ends at the Send bar, opens by itself only a topic with an open question, and
// with nothing waiting shows the hub's moon and "no open questions". A link to a question still opens its topic, as a work
// item's Questions button does (docs/adr/2026-11-06-0037-the-open-questions-page-shows-open-questions-only.md).
// Above the form is the queue of everything the header's badge counts, oldest first: a pill for each topic with an open
// question and a row for each card waiting on an Implement, a Done or another action, its button doing the tap in place
// (docs/adr/2026-11-14-2330-the-questions-page-is-one-queue-of-what-the-badge-counts.md).
// markup({embedded: true}) and ctx.embedded mount it in the board's desktop pane (app-pane.js): no header,
// and the board's URL and scroll are left alone; it holds no board of its own: the lanes' board paints it
// (ctx.host, docs/adr/2026-11-14-2230-the-desktop-pane-shows-the-lanes-board.md).
// Returning to Waiting on you opens the topic it last showed for the app's life, while that topic has an open question
// (lastTopic, by board route), and paints at once from the board's saved copy, then asks only for the changes since its
// number (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md,
// docs/adr/2026-11-14-1500-waiting-on-you-keeps-its-topic-and-paints-from-the-saved-copy.md).
const lastTopic = new Map();
(globalThis.AppViews ||= {}).questions = {
  className: 'view-questions',
  title: () => 'Waiting On You',
  markup: ({ embedded = false } = {}) => `${embedded ? '' : BoardUI.header({ lead: 'logo', title: 'Waiting on you', logoSrc: '/_hub/kickflip.png', controls: false, trail: '<span class="muted small" id="progress"></span>', pages: 'board' })}
<main>
  ${embedded ? '<span class="muted small" id="progress" hidden></span>' : ''}<section id="page"></section>
</main>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
    const { $, site } = B;
    const scroll = (y) => { if (!ctx.embedded) scrollTo(0, y); };
    const setHash = (id) => { if (!ctx.embedded) history.replaceState(history.state, '', '#' + encodeURIComponent(id)); };
    const { esc, getDraft, setDraft, choiceOf, noteOf, isSent, questionCard, roundChip, linkContext, badge, topicName, cardTopics, topicRow, nextQuestion, sentNotice, fetchJSON, downLanding } = BoardUI;
    const hashId = () => { if (ctx.embedded) return ''; const h = location.hash.slice(1); try { return decodeURIComponent(h); } catch { return h; } };

    let all = [];
    // The shown topic's resolved questions, which /api/board leaves out: GET /api/questions answers them as the topic
    // shows, and again once its resolved count changes or after a failed load, at its next draw (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md).
    let resolved = { topic: null, n: 0, questions: [] };
    // The board last landed, whose version the next load and each tap name, so an unchanged board downloads nothing
    // and a changed one comes as a patch (ui-patch.js).
    let board = null;
    let items = [];
    let topics = [];
    let topicId = null;
    let soloId = null;
    // Counts the owner's own topic picks (a pill, or the shell opening a topic), which a Send in flight compares against.
    let picks = 0;
    let shown = '';
    let sentLine = '';
    // The shown topic's questions this page has drawn unsent, which stay in place once sent or resolved until you leave
    // the topic (setTopic).
    const inPlace = new Set();
    // The footer after a prototype request: the blue spinner, then these words.
    const PROTOTYPE_REQUESTED = 'prototype requested';
    // The bar's line while a suggested option is still pre-checked.
    const SUGGESTED = 'suggested options are selected';
    const statusHtml = (line) => (line.startsWith(PROTOTYPE_REQUESTED) ? '<span class="try-spin" aria-hidden="true"></span>' : '') + esc(line);

    // Embedded, the board is the lanes' (ctx.host, app-pane.js): its load, its send, and take() for each board it lands.
    const send = (kind, data) => (ctx.embedded ? ctx.host.send(kind, data) : site.send(kind, { ...data, ...(board ? { since: board.version } : {}) }));
    const byId = (id) => all.find((q) => q.id === id) || resolved.questions.find((q) => q.id === id);
    const topicOf = (qid) => topics.find((t) => t.questions.includes(qid)) || null;
    const openTopics = () => topics.filter((t) => t.state !== 'resolved');
    const links = (q) => linkContext(items, q.topic?.startsWith('item:') ? q.topic.slice(5) : null, { base: './' });
    // Shows a topic, or none; the topic left folds its sent questions.
    const setTopic = (id) => {
      if (id !== topicId) for (const qid of topics.find((t) => t.id === topicId)?.questions || []) inPlace.delete(qid);
      topicId = id;
      if (id) lastTopic.set(B.route, id);
    };
    const urgentOpen =() => all.find((q) => q.urgent && q.state === 'open');
    // A question's number on its card: its place in its topic, which keeps every question it has had.
    const numberOf = (q) => (topicOf(q.id)?.questions.indexOf(q.id) ?? -1) + 1;
    // The questions the form shows, in order; the rest of qs fold under resolved (N).
    const inForm = (qs) => qs.filter((q) => !isSent(q) || inPlace.has(q.id));

    // docs/adr/2026-10-29-1639-waiting-on-you-leads-with-what-needs-the-owner.md
    // The queue: each topic with an open question as its pill and each tap as its row, oldest first, with the count
    // the header's badge shows (BoardUI.queueRows); the shown topic stays among them while it is sent or resolved.
    const rows = () => {
      const list = BoardUI.queueRows(board?.queue, topics);
      const shownTopic = topics.find((t) => t.id === topicId);
      return { list, drawn: shownTopic && !list.some((r) => r.topic === shownTopic) ? [...list, { topic: shownTopic }] : list };
    };
    const rowHtml = (r, arrived = false) => (r.tap ? BoardUI.tapRow(r.tap, arrived) : pillHtml(r.topic, arrived));
    const countHtml = (n) => `<div class="q-count muted small">${n} need you</div>`;
    const showsQueue = (list) => list.some((r) => r.tap) || list.length > 1;
    function topicBar() {
      const { list, drawn } = rows();
      if (!showsQueue(drawn)) return '';
      return `${countHtml(list.length)}<div class="topics" role="group" aria-label="Topics">${drawn.map((r) => rowHtml(r)).join('')}</div>`;
    }
    // An arrival (arrive) slides in with a glow and settles (style.css .arrived).
    const pillHtml = (t, arrived = false) => `<button class="${arrived ? 'arrived ' : ''}${t.progress ? 'progress' : ''}" data-topic="${esc(t.id)}" aria-pressed="${t.id === topicId}" title="${esc(t.title)}"><span class="name">${esc(topicName(t))}</span><span class="n">${t.state === 'resolved' ? 'resolved' : t.open}</span></button>`;
    const topicHead = (t) => t ? `<div class="topichead"><button class="topic-title" data-open-card="${esc(t.id)}">${esc(t.title)}</button>${t.summary ? `<span class="muted small">${esc(t.summary)}</span>` : ''}${roundChip(t.round)}</div>` : '';

    // Only open questions changed here since their last answer, with files attached, reopened with a pick, or with a
    // suggested option pre-checked and never answered, are sent; a sent one is read-only.
    const filesOf = (q) => BoardAttach.files('q:' + q.id, site.root);
    const uploading = (qs) => qs.some((q) => BoardAttach.busy('q:' + q.id, site.root));
    const pending = (qs) => BoardUI.pendingAnswers(qs, filesOf);

    function visible() {
      if (soloId) return [byId(soloId)].filter(Boolean);
      const t = topics.find((x) => x.id === topicId);
      return t ? t.questions.map(byId).filter(Boolean) : [];
    }

    // → the fetch of the topic's resolved questions, or null when they are held. force asks again; the questions held stay
    // drawn until the new ones land.
    function loadResolved(force = false) {
      const t = soloId ? null : topics.find((x) => x.id === topicId);
      if (!t?.resolved || (!force && resolved.topic === t.id && resolved.n === t.resolved)) return null;
      resolved = { topic: t.id, n: t.resolved, questions: resolved.topic === t.id ? resolved.questions : [] };
      const asked = resolved;
      return fetchJSON(site.url('api/questions?topic=' + encodeURIComponent(t.id)), { sleep: B.sleep }).then(({ body }) => {
        if (!B.alive() || resolved !== asked) return;
        asked.questions = body.questions || [];
        repaint(false);
      }, () => { if (resolved === asked) resolved = { topic: null, n: 0, questions: [] }; });
    }

    function render() {
      loadResolved();
      drawn = drawnOf();
      const el = $('#page');
      const qs = visible();
      if (!qs.length && rows().list.some((r) => r.tap)) {
        el.innerHTML = topicBar();
        $('#progress').textContent = '';
        return;
      }
      if (!qs.length) {
        el.innerHTML = `<div class="q-empty"><svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HubUI.TILE_PATHS.moon}</svg><p class="muted">no open questions</p></div>`;
        $('#progress').textContent = '';
        return;
      }
      const t = topics.find((x) => x.id === topicId);
      const live = inForm(qs);
      const done = qs.filter((q) => !live.includes(q));
      for (const q of live) inPlace.add(q.id);
      const head = soloId
        ? `<div class="solo">${badge('notice', 'needs you first')}<button class="ghost" id="showAll">All questions</button></div>`
        : `${topicBar()}${topicHead(t)}`;
      el.innerHTML = `${head}<form id="qform">
        ${done.length ? `<details class="done resolved-group"${live.length ? '' : ' open'}><summary><span class="caret" aria-hidden="true">›</span><span>resolved (${done.length})</span></summary>${done.map((q) => questionCard(q, { n: numberOf(q), links: links(q) })).join('')}</details>` : ''}
        ${live.map((q) => questionCard(q, { n: numberOf(q), draft: getDraft(q.id), links: links(q) })).join('')}
        <div class="bar"><span class="muted small${sentLine ? ' sent' : ''}" id="qstatus" role="status">${statusHtml(sentLine)}</span>${BoardUI.sendButton('Send', 0, ' id="send"')}</div>
      </form>`;
      BoardAttach.paintAll();
      updateBar();
    }

    // A toast names a topic by its card's ref, the title up to its colon; an ask by its time.
    const toastName = (t) => String(t.title).match(/^(\S+):/)?.[1] || t.title;
    // The topic a tap on this page acts for, the pills before it and its name, which moveOn reads once it is recorded.
    function leaving() {
      const from = soloId ? topicOf(soloId)?.id : topicId;
      return { from, picks, pills: topicRow(topics, from).pills, name: toastName(topics.find((t) => t.id === from) || { title: '' }) };
    }
    // After a recorded tap: a load that started before it went out would read its question as still open.
    // `footer` is a line or, for a Send, a function of the reloaded board giving the whole line.
    // The tap's POST answers with the board as it left it, which lands here in place of a reload.
    async function moveOnOnceLoaded({ from, pills, picks: at }, what, out, footer = what) {
      await loading;
      if (!B.alive()) return;
      // Embedded, the host's send landed the answer in the lanes' board, which take() drew here.
      if (!ctx.embedded && !land(out.board, false)) await load(false);
      // Tapped to another topic meanwhile: the page stays there and only the toast says what was recorded.
      if (picks !== at) { B.toast(what); return; }
      moveOn(from, pills, what, typeof footer === 'function' ? footer() : footer, typeof footer !== 'function');
    }

    // A tap's change no load has drawn in BoardUI's PENDING_LATE_MS: the board loads once and the button rests.
    function stillWaiting() {
      if (!B.alive()) return;
      B.toast('Still waiting on the board');
      shown = '';
      load(false);
    }
    // A refusal rests the button with its reason on the status line, as before.
    const refused = (e) => { $('#qstatus').textContent = e.reason ? `Nothing was sent: ${e.reason}` : 'Could not send. Is the host awake?'; };

    // The tapped Prototype button waits (ui.js waitOn) until the page shows the request
    // (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
    function askPrototype(q, button) {
      const key = q.topic?.startsWith('item:') ? q.topic.slice(5) : null;
      const at = leaving();
      $('#qstatus').textContent = '';
      const d = getDraft(q.id);
      return BoardUI.waitOn(button, BoardUI.pending.within((async () => {
        let out;
        try { out = await send('prototype-request', { ...(key ? { key } : {}), question: q.id, note: noteOf(q, d).trim(), choice: choiceOf(q, d) }); } catch (e) { refused(e); return; }
        setDraft(q.id, {});
        await moveOnOnceLoaded(at, `Prototype requested${at.name ? ` for ${at.name}` : ''}.`, out, PROTOTYPE_REQUESTED);
      })(), stillWaiting));
    }

    // A sent question's Resolved badge reopens it once the owner confirms: the question opens in place with its last
    // pick and note, and stays in the form until you leave the topic.
    async function reopen(q, button) {
      if (!(await BoardDialogs.confirm('Reopen this question?')) || !B.alive()) return;
      const key = q.topic?.startsWith('item:') ? q.topic.slice(5) : null;
      await BoardUI.waitOn(button, BoardUI.pending.within((async () => {
        let out;
        try { out = await send('question-reopen', { ...(key ? { key } : {}), question: q.id }); } catch (e) { refused(e); return; }
        if (!B.alive()) return;
        inPlace.add(q.id);
        sentLine = '';
        if (!land(out.board, false)) await load(false);
        repaint(false);
      })(), stillWaiting));
    }

    // A tap row's button: Implement and Done do their tap in place, once the owner confirms, and the queue drops the row
    // when the board lands; Ready and Action only open the card.
    const TAP_EVENT = { implement: 'card-build', done: 'card-done' };
    async function doTap(kind, key, button) {
      if (!TAP_EVENT[kind]) { openOnBoard(`item:${key}`); return; }
      const tap = rows().list.find((r) => r.tap?.key === key)?.tap;
      const ref = toastName({ title: tap.title });
      if (!(await BoardDialogs.confirm(`${kind === 'implement' ? 'Implement' : 'Mark done'} ${ref}?`)) || !B.alive()) return;
      await BoardUI.waitOn(button, BoardUI.pending.within((async () => {
        let out;
        try { out = await send(TAP_EVENT[kind], { key }); } catch (e) { B.toast(e.reason ? `Nothing was sent: ${e.reason}` : 'Could not send. Is the host awake?'); return; }
        if (!B.alive()) return;
        if (!ctx.embedded && !land(out.board, false)) await load(false);
        repaint(false);
      })(), stillWaiting));
    }

    function updateBar() {
      const qs = visible();
      const n = pending(qs).length;
      const b = $('#send');
      if (b) { b.disabled = !n || uploading(qs); b.childNodes[0].textContent =uploading(qs) ? 'Uploading…' : 'Send'; }
      const live = inForm(qs);
      const answered = live.filter((q) => q.state !== 'open').length;
      // docs/adr/2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md
      const prechecked = live.some((q) => q.suggested && !q.answers.length && choiceOf(q, getDraft(q.id)) === q.suggested.option);
      const st = $('#qstatus');
      if (st && !sentLine && (prechecked || st.textContent === SUGGESTED)) st.textContent = prechecked ? SUGGESTED : '';
      $('#progress').textContent = live.length > 1 ? `${answered}/${live.length} answered` : '';
    }

    function pick(hash) {
      const u = urgentOpen();
      if (u && (!hash || hash === u.id)) { soloId = u.id; setTopic(topicOf(u.id)?.id ?? null); return; }
      soloId = null;
      const t = (hash && topicOf(hash)) || topics.find((x) => x.id === lastTopic.get(B.route) && x.open) || topics.find((x) => x.open);
      setTopic(t ? t.id : null);
    }

    const sigNow = () => JSON.stringify([soloId, topicId, board?.queue, topics.map((t) => [t.id, t.state, t.open, t.answered, t.round]), visible().map((q) => [q.id, q.state, q.answers.length, q.answers.map((a) => Boolean(a.reply)), Boolean(q.reask)])]);
    // One load at a time: a load waiting out a board restart would otherwise overlap the next poll's. A load asked for
    // while one runs shares it. → true when the board's answer landed in this view.
    let loading = null;
    let loaded = false;
    const load = (first) => (ctx.embedded ? ctx.host.reload() : (loading ||= fetchBoard(first).finally(() => { loading = null; })));
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
        repaint(true);
      });
    };
    async function fetchBoard(first) {
      try {
        const { body: d } = await fetchJSON(site.url('api/board' + (board ? '?since=' + encodeURIComponent(board.version) : '')), { tag: board?.version, onWait: (ms, down) => out(down), sleep: B.sleep });
        if (!B.alive()) return false;
        root.classList.remove('offline');
        if (d) land(d, first);
        repaint(first);
        return true;
      } catch (e) {
        out(e.down);
        return false;
      }
    }
    // A board, or a patch from the board held, from a load or a tap's POST. → false for a patch from a board no longer
    // held, which leaves the page as it is.
    function land(d, first) {
      const next = d.since === undefined ? d : BoardUI.applyPatch(board, d);
      if (!next) return false;
      board = next;
      all = board.owner;
      items = board.items;
      topics = cardTopics(board.ownerTopics, items);
      site.syncBadge();
      if (first) pick(hashId());
      else if (soloId && byId(soloId)?.state !== 'open') pick('');
      else if (!topics.some((t) => t.id === topicId)) pick('');
      loaded = true;
      if (first && !ctx.embedded) toSheet(hashId());
      return true;
    }
    // A push tap on an open question of a card opens that card on the board with its questions sheet, in place of this
    // page, which stays for every other way here (app-questions-sheet.js,
    // docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md). A prototype's question stays here.
    function toSheet(id) {
      const q = history.state?.pushed === true && byId(id);
      if (!q || q.state !== 'open' || !q.topic?.startsWith('item:') || BoardUI.isPrototype(q.url)) return;
      AppShell.open(new URL(`./#selectedCard=${encodeURIComponent(q.topic.slice(5))}&questions=${encodeURIComponent(id)}`, location.href).href, { replace: true });
    }
    // Draws what changed: an arrival in place (arrive), else the whole page, unless the owner is typing a note.
    function repaint(first) {
      const sig = sigNow();
      if (sig === shown) return;
      if (!first && arrive()) { shown = sig; return; }
      const active = document.activeElement;
      if (active && active.tagName === 'TEXTAREA') return;
      shown = sig;
      const y = scrollY;
      render();
      scroll(first ? 0 : y);
    }

    // What render last drew of the topic: its questions in order as they stood, and its resolved count.
    const drawnOf = () => {
      const t = topics.find((x) => x.id === topicId);
      return { solo: soloId, topic: topicId, resolved: t?.resolved || 0, taps: JSON.stringify(rows().list.filter((r) => r.tap)), qs: visible().map((q) => JSON.stringify([q.id, q.state, q.answers.length, q.answers.map((a) => Boolean(a.reply)), Boolean(q.reask)])) };
    };
    let drawn = null;
    // A change that only adds topics, counts or open questions at the end of the shown topic is drawn in place: each
    // pill keeps its node and a new one lands at its place in the row, a new question's card goes after the last open
    // one, and the topic line and the bar update. → false when anything shown changed.
    function arrive() {
      const form = $('#qform');
      const now = drawnOf();
      if (!form || !drawn || now.solo || drawn.solo || now.topic !== drawn.topic || now.resolved !== drawn.resolved || now.taps !== drawn.taps
        || drawn.qs.some((s, i) => now.qs[i] !== s)) return false;
      const added = visible().slice(drawn.qs.length);
      if (added.some((q) => q.state !== 'open')) return false;
      const page = $('#page');
      const { list, drawn: shownRows } = rows();
      const bar = page.querySelector('.topics');
      if (!showsQueue(shownRows)) { bar?.remove(); page.querySelector('.q-count')?.remove(); }
      else if (!bar) page.insertAdjacentHTML('afterbegin', topicBar());
      else {
        const nodeOf = (r) => (r.tap ? bar.querySelector(`.tap[data-tap="${CSS.escape(r.tap.key)}"]`) : bar.querySelector(`button[data-topic="${CSS.escape(r.topic.id)}"]`)) || fragmentOf(rowHtml(r, true));
        const nodes = shownRows.map(nodeOf);
        for (const b of [...bar.children]) if (!nodes.includes(b)) b.remove();
        nodes.forEach((b, i) => {
          const t = shownRows[i].topic;
          if (t) {
            b.setAttribute('aria-pressed', String(t.id === topicId));
            b.querySelector('.n').textContent = t.state === 'resolved' ? 'resolved' : String(t.open);
          }
          if (bar.children[i] !== b) bar.insertBefore(b, bar.children[i] || null);
        });
        page.querySelector('.q-count').textContent = `${list.length} need you`;
      }
      const head = page.querySelector('.topichead');
      const headHtml = topicHead(topics.find((x) => x.id === topicId));
      if (head && head.outerHTML !== headHtml) head.outerHTML = headHtml;
      const sendBar = form.querySelector('.bar');
      for (const q of added) {
        inPlace.add(q.id);
        sendBar.insertAdjacentHTML('beforebegin', questionCard(q, { n: numberOf(q), draft: getDraft(q.id), links: links(q) }));
      }
      BoardAttach.paintAll();
      drawn = now;
      updateBar();
      return true;
    }
    const fragmentOf = (html) => { const box = document.createElement('div'); box.innerHTML = html; return box.firstElementChild; };

    function moveOn(from, pills, what, footer = what, countOpen = true) {
      soloId = null;
      const next = nextQuestion(all, pills, { topic: from });
      const left = topics.find((t) => t.id === from)?.open || 0;
      if (next?.topic === from) {
        sentLine = countOpen ? `${footer.replace(/\.?$/, '.')} ${left} still open.` : footer;
        shown = sigNow();
        const y = scrollY;
        render();
        scroll(y);
        return;
      }
      sentLine = footer;
      if (!next) {
        sentNotice.put(B.route, what);
        if (ctx.up?.()) return;
        sentNotice.take(B.route);
        setTopic(null);
        B.toast(what);
      } else {
        setTopic(next.topic);
        setHash(next.id);
      }
      shown = sigNow();
      render();
      scroll(0);
    }

    // item:<key> is a card. Embedded, the board is beside the pane; alone, it is the page before this one.
    function openOnBoard(id) {
      if (ctx.embedded) return ctx.openOnBoard(id);
      if (!id.startsWith('item:')) return;
      const href = new URL(`./#item=${encodeURIComponent(id.slice(5))}`, location.href).href;
      if (!AppShell.open(href)) location.assign(href);
    }
    B.on(root, 'click', (ev) => {
      if (ev.target.id === 'showAll') { soloId = null; sentLine = ''; shown = ''; render(); return; }
      const eye = ev.target.closest && ev.target.closest('[data-proto]');
      if (eye) { askPrototype(byId(eye.closest('section.q').dataset.q), eye); return; }
      const reopenBadge = ev.target.closest && ev.target.closest('[data-reopen]');
      if (reopenBadge) { if (!reopenBadge.disabled) reopen(byId(reopenBadge.dataset.reopen), reopenBadge); return; }
      const tapButton = ev.target.closest && ev.target.closest('[data-tap-do]');
      if (tapButton) { if (!tapButton.disabled) doTap(tapButton.dataset.tapDo, tapButton.dataset.key, tapButton); return; }
      const title = ev.target.closest && ev.target.closest('[data-open-card]');
      if (title) { openOnBoard(title.dataset.openCard); return; }
      const b = ev.target.closest && ev.target.closest('[data-topic]');
      if (b) {
        // Embedded in the desktop pane, one click also focuses the topic's card on the board; a phone only picks the topic.
        picks++; soloId = null; setTopic(b.dataset.topic); sentLine = ''; shown = '';
        const first = topics.find((t) => t.id === topicId)?.questions[0];
        if (first) setHash(first);
        ctx.onTopic?.(topicId);
        const y = scrollY;
        render(); scroll(y);
        if (ctx.embedded) openOnBoard(topicId);
      }
    });
    BoardUI.wireAnswerForm(B.on, root, updateBar);
    B.on(root, 'submit', async (ev) => {
      if (ev.target.id !== 'qform') return;
      ev.preventDefault();
      const list = pending(visible());
      const st = $('#qstatus');
      if (uploading(visible())) return;
      if (!list.length) { st.textContent = 'Pick an option or write a note first.'; return; }
      st.textContent = '';
      const at = leaving();
      // docs/adr/2026-11-03-1519-send-records-every-ready-answer-in-one-request.md: one request, recorded all or none. Send waits meanwhile.
      const answers = list.map((q) => BoardUI.answerOf(q, filesOf(q)));
      // Send waits until the page has moved on (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
      await BoardUI.waitOn($('#send'), BoardUI.pending.within((async () => {
        let out;
        try { out = await send('owner-answers', { answers }); } catch (e) { refused(e); return; }
        for (const q of list) {
          setDraft(q.id, {});
          BoardAttach.clear('q:' + q.id, site.root);
        }
        await moveOnOnceLoaded(at, `Sent ${list.length} answer${list.length === 1 ? '' : 's'}${at.name ? ` to ${at.name}` : ''}.`, out, () => {
          const open = all.filter((q) => q.state === 'open').length;
          return `sent ${list.length} answer${list.length === 1 ? '' : 's'}${open ? ` · ${open} still open` : ''}`;
        });
      })(), stillWaiting));
    });
    // Each composer painted raises a bubbling attach-change (attach.js).
    B.on(root, 'attach-change', updateBar);
    // A link to another question here only moves the hash.
    // A link to a question this page's board doesn't have yet (a push tap on a page left in the background) loads the
    // board first, then opens its topic. Embedded in the board's pane, the board's hash is not this page's.
    if (!ctx.embedded) B.on(window, 'hashchange', async () => {
      if (!loaded) return;
      const id = hashId();
      if (id && !byId(id) && !topicOf(id)) {
        await load(false);
        if (!B.alive() || hashId() !== id) return;
      }
      pick(id);
      sentLine = '';
      shown = '';
      render();
      scroll(0);
    });

    // In the board's pane, the shell opens the topic of a question or topic id there, a resolved one included, and with
    // none or one that's gone the topic the page would open (app-pane.js focusQuestion). → false before the first load.
    if (ctx.embedded) B.openTopic = (id) => {
      if (!loaded) return false;
      const topic = topics.find((t) => t.id === id);
      if (topic) { picks++; soloId = null; setTopic(topic.id); } else pick(id || '');
      ctx.onTopic?.(topicId);
      sentLine = '';
      shown = '';
      render();
      return true;
    };

    // The saved copy of this build paints first, and the load names its number; with none, the load is the whole board.
    // Embedded, the lanes' board paints here with no fetch: take() draws each board the lanes land, and this the one held.
    if (ctx.embedded) {
      B.take = (d) => { if (d !== board && land(d, !loaded)) repaint(!shown); };
      const held = ctx.host.board();
      if (held) B.take(held);
      return;
    }
    BoardUI.boardCopy(site.url(''), document.documentElement.dataset.build).then((c) => {
      if (B.alive() && c && !board) { land(c.board, true); repaint(true); }
    }, () => {}).then(() => { if (B.alive()) load(!board); });
    B.every(15000, () => { if (!document.hidden) load(false); });
    B.on(document, 'visibilitychange', () => { if (!document.hidden) load(false); });
    // A pick drafted on a standalone prototype page shows when this page returns from the browser cache.
    B.on(window, 'pageshow', (ev) => { if (ev.persisted) { shown = ''; load(false); } });
  }),
};
