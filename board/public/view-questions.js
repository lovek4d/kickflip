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
// A question the owner has sent an answer to is resolved: read-only, green, with a Resolved badge. One that resolves
// while its topic shows stays in place until you leave that topic, by a pill, a link or the move on after the last
// Send; a topic's sent questions otherwise fold under "resolved (N)", which names only the count, above its open ones. A sent question's badge, once confirmed, sends `question-reopen {key?, question}`, and the question
// opens again with its last pick and note for a new Send. Each question is numbered by its place on its card
// (docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md,
// docs/adr/2026-11-06-1100-resolved-questions-fold-away-once-you-leave-their-topic.md).
// A topic or question that arrives while the page shows inserts its pill or card where it belongs, and the counts
// update, with no repaint, so the open topic, its picks, the note being typed and the scroll stay
// (docs/adr/2026-11-05-0408-needs-you-is-a-deck-on-a-phone-and-a-pane-on-a-desktop.md).
// The page shows open questions only: it ends at the Send bar, opens by itself only a topic with an open question, and
// with none shows the hub's moon and "no open questions". A link to a question still opens its topic, as a work item's
// Questions button does (docs/adr/2026-11-06-0037-the-open-questions-page-shows-open-questions-only.md).
// markup({embedded: true}) and ctx.embedded mount it in the board's desktop Needs you pane (app-needs.js): no header,
// and the board's URL and scroll are left alone.
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
    const { esc, getDraft, setDraft, choiceLabel, choiceOf, noteOf, isSent, questionCard, roundChip, linkContext, badge, topicName, cardTopics, topicRow, nextQuestion, sentNotice, fetchJSON, downLanding } = BoardUI;
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

    const send = (kind, data) => site.send(kind, { ...data, ...(board ? { since: board.version } : {}) });
    const byId = (id) => all.find((q) => q.id === id) || resolved.questions.find((q) => q.id === id);
    const topicOf = (qid) => topics.find((t) => t.questions.includes(qid)) || null;
    const openTopics = () => topics.filter((t) => t.state !== 'resolved');
    const links = (q) => linkContext(items, q.topic?.startsWith('item:') ? q.topic.slice(5) : null, { base: './' });
    // Shows a topic, or none; the topic left folds its sent questions.
    const setTopic = (id) => {
      if (id !== topicId) for (const qid of topics.find((t) => t.id === topicId)?.questions || []) inPlace.delete(qid);
      topicId = id;
    };
    const urgentOpen =() => all.find((q) => q.urgent && q.state === 'open');
    // A question's number on its card: its place in its topic, which keeps every question it has had.
    const numberOf = (q) => (topicOf(q.id)?.questions.indexOf(q.id) ?? -1) + 1;
    // The questions the form shows, in order; the rest of qs fold under resolved (N).
    const inForm = (qs) => qs.filter((q) => !isSent(q) || inPlace.has(q.id));

    // docs/adr/2026-10-29-1639-waiting-on-you-leads-with-what-needs-the-owner.md
    function topicBar() {
      const list = topicRow(topics, topicId).pills;
      if (list.length < 2) return '';
      return `<div class="topics" role="group" aria-label="Topics">${list.map((t) => pillHtml(t)).join('')}</div>`;
    }
    // An arrival (arrive) slides in with a glow and settles (style.css .arrived).
    const pillHtml = (t, arrived = false) => `<button class="${arrived ? 'arrived ' : ''}${t.progress ? 'progress' : ''}" data-topic="${esc(t.id)}" aria-pressed="${t.id === topicId}" title="${esc(t.title)}">${esc(topicName(t))}<span class="n">${t.state === 'resolved' ? 'resolved' : t.open}</span></button>`;
    const topicHead = (t) => t ? `<div class="topichead muted small"><span>${esc(t.title)}${t.summary ? ` · ${esc(t.summary)}` : ''}</span>${roundChip(t.round)}</div>` : '';

    // Only open questions changed here since their last answer, with files attached, reopened with a pick, or with a
    // suggested option pre-checked and never answered, are sent; a sent one is read-only.
    const filesOf = (q) => BoardAttach.files('q:' + q.id, site.root);
    const uploading = (qs) => qs.some((q) => BoardAttach.busy('q:' + q.id, site.root));
    function pending(qs) {
      return qs.filter((q) => q.state === 'open').filter((q) => {
        const d = getDraft(q.id);
        if (filesOf(q).length) return true;
        const last = q.answers[q.answers.length - 1];
        if (!last && q.suggested) return true;
        if (q.reopened && choiceOf(q, d) !== null) return true;
        if (!('choice' in d) && !d.note) return false;
        return !last || (d.choice ?? last.choice) !== last.choice || (d.note || '') !== (last.note || '');
      });
    }

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
        ${done.length ? `<details class="done resolved-group"><summary><span class="caret" aria-hidden="true">›</span><span>resolved (${done.length})</span></summary>${done.map((q) => questionCard(q, { n: numberOf(q), links: links(q) })).join('')}</details>` : ''}
        ${live.map((q) => questionCard(q, { n: numberOf(q), draft: getDraft(q.id), links: links(q) })).join('')}
        <div class="bar"><span class="muted small${sentLine ? ' sent' : ''}" id="qstatus" role="status">${statusHtml(sentLine)}</span><span class="send-hint" aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘↵' : 'Ctrl+↵'}</span><button class="primary" type="submit" id="send">Send</button></div>
      </form>`;
      BoardAttach.paintAll();
      updateBar();
    }

    // The topic a tap on this page acts for, the pills before it and its name, which moveOn reads once it is recorded.
    function leaving() {
      const from = soloId ? topicOf(soloId)?.id : topicId;
      return { from, pills: topicRow(topics, from).pills, name: topicName(topics.find((t) => t.id === from) || { title: '' }) };
    }
    // After a recorded tap: a load that started before it went out would read its question as still open.
    // `footer` is a line or, for a Send, a function of the reloaded board giving the whole line.
    // The tap's POST answers with the board as it left it, which lands here in place of a reload.
    async function moveOnOnceLoaded({ from, pills }, what, out, footer = what) {
      await loading;
      if (!B.alive()) return;
      if (!land(out.board, false)) await load(false);
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

    function updateBar() {
      const qs = visible();
      const n = pending(qs).length;
      const b = $('#send');
      if (b) { b.disabled = !n || uploading(qs); b.textContent = uploading(qs) ? 'Uploading…' : 'Send'; }
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
      const t = (hash && topicOf(hash)) || topics.find((x) => x.open);
      setTopic(t ? t.id : null);
    }

    const sigNow = () => JSON.stringify([soloId, topicId, topics.map((t) => [t.id, t.state, t.open, t.answered, t.round]), visible().map((q) => [q.id, q.state, q.answers.length, q.answers.map((a) => Boolean(a.reply)), Boolean(q.reask)])]);
    // One load at a time: a load waiting out a board restart would otherwise overlap the next poll's. A load asked for
    // while one runs shares it. → true when the board's answer landed in this view.
    let loading = null;
    let loaded = false;
    const load = (first) => (loading ||= fetchBoard(first).finally(() => { loading = null; }));
    // While the board can't be reached, the page holds its sending buttons and shows the board's copy here, painted live,
    // or with none and nothing landed the landing for why (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
    let copy = null;
    BoardUI.holdSends(B.on, root, () => root.classList.contains('offline'));
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
      return true;
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
      return { solo: soloId, topic: topicId, resolved: t?.resolved || 0, qs: visible().map((q) => JSON.stringify([q.id, q.state, q.answers.length, q.answers.map((a) => Boolean(a.reply)), Boolean(q.reask)])) };
    };
    let drawn = null;
    // A change that only adds topics, counts or open questions at the end of the shown topic is drawn in place: each
    // pill keeps its node and a new one lands at its place in the row, a new question's card goes after the last open
    // one, and the topic line and the bar update. → false when anything shown changed.
    function arrive() {
      const form = $('#qform');
      const now = drawnOf();
      if (!form || !drawn || now.solo || drawn.solo || now.topic !== drawn.topic || now.resolved !== drawn.resolved
        || drawn.qs.some((s, i) => now.qs[i] !== s)) return false;
      const added = visible().slice(drawn.qs.length);
      if (added.some((q) => q.state !== 'open')) return false;
      const page = $('#page');
      const list = topicRow(topics, topicId).pills;
      const bar = page.querySelector('.topics');
      if (list.length < 2) bar?.remove();
      else if (!bar) page.insertAdjacentHTML('afterbegin', topicBar());
      else {
        const pills = list.map((t) => bar.querySelector(`button[data-topic="${CSS.escape(t.id)}"]`) || fragmentOf(pillHtml(t, true)));
        for (const b of [...bar.children]) if (!pills.includes(b)) b.remove();
        pills.forEach((b, i) => {
          const t = list[i];
          b.setAttribute('aria-pressed', String(t.id === topicId));
          b.querySelector('.n').textContent = t.state === 'resolved' ? 'resolved' : String(t.open);
          if (bar.children[i] !== b) bar.insertBefore(b, bar.children[i] || null);
        });
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

    B.on(root, 'click', (ev) => {
      if (ev.target.id === 'showAll') { soloId = null; sentLine = ''; shown = ''; render(); return; }
      const eye = ev.target.closest && ev.target.closest('[data-proto]');
      if (eye) { askPrototype(byId(eye.closest('section.q').dataset.q), eye); return; }
      const reopenBadge = ev.target.closest && ev.target.closest('[data-reopen]');
      if (reopenBadge) { if (!reopenBadge.disabled) reopen(byId(reopenBadge.dataset.reopen), reopenBadge); return; }
      const b = ev.target.closest && ev.target.closest('[data-topic]');
      if (b) {
        soloId = null; setTopic(b.dataset.topic); sentLine = ''; shown = '';
        const first = topics.find((t) => t.id === topicId)?.questions[0];
        if (first) setHash(first);
        render(); scroll(0);
      }
    });
    B.on(root, 'change', (ev) => {
      const sec = ev.target.closest('section.q'); if (!sec || ev.target.type !== 'radio') return;
      const d = getDraft(sec.dataset.q); d.choice = ev.target.value; setDraft(sec.dataset.q, d); updateBar();
    });
    B.on(root, 'input', (ev) => {
      const sec = ev.target.closest('section.q'); if (!sec || ev.target.tagName !== 'TEXTAREA') return;
      const d = getDraft(sec.dataset.q); d.note = ev.target.value; setDraft(sec.dataset.q, d); updateBar();
    });
    B.on(root, 'keydown', (ev) => {
      if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || ev.isComposing || ev.target.tagName !== 'TEXTAREA') return;
      const form = ev.target.closest('#qform');
      if (!form) return;
      ev.preventDefault();
      form.requestSubmit();
    });
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
      const answers = list.map((q) => {
        const d = getDraft(q.id);
        const choice = choiceOf(q, d);
        const files = filesOf(q);
        return { id: q.id, question: q.question, choice, label: choiceLabel(q, choice), note: noteOf(q, d).trim(), ...(files.length ? { files } : {}) };
      });
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
    if (!ctx.embedded) B.on(window, 'hashchange', () => {
      if (!loaded) return;
      pick(hashId());
      sentLine = '';
      shown = '';
      render();
      scroll(0);
    });

    // In the board's pane, the shell opens the topic of a question or topic id there, a resolved one included, and with
    // none or one that's gone the topic the page would open (app-needs.js focusQuestion). → false before the first load.
    if (ctx.embedded) B.openTopic = (id) => {
      if (!loaded) return false;
      const topic = topics.find((t) => t.id === id);
      if (topic) { soloId = null; setTopic(topic.id); } else pick(id || '');
      sentLine = '';
      shown = '';
      render();
      return true;
    };

    load(true);
    B.every(15000, () => { if (!document.hidden) load(false); });
    B.on(document, 'visibilitychange', () => { if (!document.hidden) load(false); });
    // A pick drafted on a standalone prototype page shows when this page returns from the browser cache.
    B.on(window, 'pageshow', (ev) => { if (ev.persisted) { shown = ''; load(false); } });
  }),
};
