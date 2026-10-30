// Waiting on you, /<route>/questions.html#<question id>, a view of the app shell (shell.js). A topic's questions show
// on one page with one Send at the bottom, which sends an `owner-answer` event per question answered there; the rest
// stay open for a later visit. Once every answer has sent, a topic with a question still open stays; one with none
// opens the topic whose pill was to its left before the Send, else to its right, and with no topic left that has an
// open question goes back to the board, where the Sent line shows as a toast (BoardUI.sentNotice). An open question
// with `urgent: true` in owner.json shows alone first, and its Send follows the same rule for its topic. A question
// whose options are prototype takes frames each take with ?take= (docs/adr/0048-a-questions-takes-show-inline.md).
(globalThis.AppViews ||= {}).questions = {
  className: 'view-questions',
  title: () => 'Waiting On You',
  markup: () => `${BoardUI.header({ lead: 'back', title: 'Waiting on you', controls: false, trail: '<span class="muted small" id="progress"></span>' })}
<main>
  <section id="page"></section>
</main>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
    const { $, site } = B;
    const { esc, choiceLabel, questionCard, linkContext, badge, topicName, topicRow, sentNotice, fetchJSON, restartNotice } = BoardUI;
    // prototype-switcher.js reads a draft's note and clears the draft once it sends that question's answer.
    const draftKey = (id) => 'qdraft:' + id;
    const getDraft = (id) => { try { return JSON.parse(localStorage.getItem(draftKey(id)) || '{}'); } catch { return {}; } };
    const setDraft = (id, v) => { try { localStorage.setItem(draftKey(id), JSON.stringify(v)); } catch {} };
    const hashId = () => { const h = location.hash.slice(1); try { return decodeURIComponent(h); } catch { return h; } };

    let all = [];
    let items = [];
    let topics = [];
    let topicId = null;
    let soloId = null;
    let shown = '';
    let sentLine = '';

    const byId = (id) => all.find((q) => q.id === id);
    const topicOf = (qid) => topics.find((t) => t.questions.includes(qid)) || null;
    const openTopics = () => topics.filter((t) => t.state !== 'resolved');
    const needsOwner = (id) => topics.some((t) => t.id === id && t.state !== 'resolved' && t.open > 0);
    const links = (q) => linkContext(items, q.topic?.startsWith('item:') ? q.topic.slice(5) : null, { base: './' });
    const urgentOpen = () => all.find((q) => q.urgent && q.state === 'open');

    // docs/adr/0038-waiting-on-you-leads-with-what-needs-the-owner.md
    function topicBar() {
      const list = topicRow(topics, topicId).pills;
      if (list.length < 2) return '';
      return `<div class="topics" role="group" aria-label="Topics">${list.map((t) =>
        `<button data-topic="${esc(t.id)}" aria-pressed="${t.id === topicId}" title="${esc(t.title)}">${esc(topicName(t))}<span class="n">${t.state === 'resolved' ? 'resolved' : t.open}</span></button>`).join('')}</div>`;
    }
    const topicHead = (t) => t ? `<div class="topichead muted small">${esc(t.title)}${t.summary ? ` · ${esc(t.summary)}` : ''}</div>` : '';

    // Only questions changed here since their last answer, or with files attached, are sent.
    const filesOf = (q) => BoardAttach.files('q:' + q.id, site.root);
    const uploading = (qs) => qs.some((q) => BoardAttach.busy('q:' + q.id, site.root));
    function pending(qs) {
      return qs.filter((q) => {
        const d = getDraft(q.id);
        if (filesOf(q).length) return true;
        if (!('choice' in d) && !d.note) return false;
        const last = q.answers[q.answers.length - 1];
        return !last || (d.choice ?? last.choice) !== last.choice || (d.note || '') !== (last.note || '');
      });
    }

    function visible() {
      if (soloId) return [byId(soloId)].filter(Boolean);
      const t = topics.find((x) => x.id === topicId);
      return t ? t.questions.map(byId).filter(Boolean) : [];
    }

    function render() {
      const el = $('#page');
      const qs = visible();
      if (!qs.length) {
        el.innerHTML = '<p class="muted">Nothing is waiting on you.</p>' + waitingTopics() + resolvedTopics();
        $('#progress').textContent = '';
        return;
      }
      const t = topics.find((x) => x.id === topicId);
      const live = qs.filter((q) => q.state !== 'resolved');
      const done = qs.filter((q) => q.state === 'resolved');
      const head = soloId
        ? `<div class="solo">${badge('notice', 'needs you first')}<button class="ghost" id="showAll">All questions</button></div>`
        : `${topicBar()}${topicHead(t)}`;
      el.innerHTML = `${head}<form id="qform">
        ${live.map((q, i) => questionCard(q, { n: soloId ? 0 : i + 1, draft: getDraft(q.id), links: links(q) })).join('')}
        ${done.length ? `<details class="done"><summary>Resolved · ${done.length}</summary>${done.map((q) => questionCard(q, { draft: getDraft(q.id), links: links(q) })).join('')}</details>` : ''}
        <div class="bar"><span class="muted small${sentLine ? ' sent' : ''}" id="qstatus" role="status">${esc(sentLine)}</span><span class="send-hint" aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘↵' : 'Ctrl+↵'}</span><button class="primary" type="submit" id="send">Send</button></div>
      </form>${soloId ? '' : waitingTopics() + resolvedTopics()}`;
      BoardAttach.paintAll();
      el.querySelectorAll('.takes').forEach(wireTakes);
      updateBar();
    }

    // The dot under the take in view is on; a dot's tap brings its take into view. Opens on the pick, if any. Its
    // listeners sit on the take's own elements, which the next render replaces.
    function wireTakes(box) {
      const track = box.querySelector('.take-track');
      const dots = [...box.querySelectorAll('[data-dot]')];
      const lab = box.querySelector('.lab');
      const centre = (c) => c.offsetLeft - (track.clientWidth - c.offsetWidth) / 2;
      const at = () => {
        const cards = [...track.children];
        return cards.reduce((best, c, i) => (Math.abs(centre(c) - track.scrollLeft) < Math.abs(centre(cards[best]) - track.scrollLeft) ? i : best), 0);
      };
      const paint = () => { const i = at(); dots.forEach((d, j) => d.classList.toggle('on', j === i)); lab.textContent = `${i + 1} of ${dots.length}`; };
      track.addEventListener('scroll', () => requestAnimationFrame(paint), { passive: true });
      dots.forEach((d, i) => d.addEventListener('click', () => track.scrollTo({ left: centre(track.children[i]), behavior: 'smooth' })));
      const picked = dots.findIndex((d) => d.classList.contains('picked'));
      if (picked > 0) { track.scrollLeft = centre(track.children[picked]); paint(); }
    }

    function waitingTopics() {
      const list = topicRow(topics, topicId).waiting;
      return list.length ? `<details class="done"><summary>Waiting on Claude · ${list.length}</summary>${list.map((t) =>
        `<div class="trow"><button class="ghost" data-topic="${esc(t.id)}">${esc(t.title)}</button><span class="muted small">${t.answered ? 'answered' : 'Claude replied'}</span></div>`).join('')}</details>` : '';
    }

    function resolvedTopics() {
      const done = topics.filter((t) => t.state === 'resolved' && t.id !== topicId);
      return done.length ? `<details class="done"><summary>Resolved topics · ${done.length}</summary>${done.map((t) =>
        `<div><button class="ghost" data-topic="${esc(t.id)}">${esc(t.title)}</button></div>`).join('')}</details>` : '';
    }

    function updateBar() {
      const qs = visible();
      const n = pending(qs).length;
      const b = $('#send');
      if (b) { b.disabled = !n || uploading(qs); b.textContent = uploading(qs) ? 'Uploading…' : n ? `Send ${n} answer${n === 1 ? '' : 's'}` : 'Send'; }
      const live = qs.filter((q) => q.state !== 'resolved');
      const answered = live.filter((q) => q.state !== 'open').length;
      $('#progress').textContent = live.length > 1 ? `${answered}/${live.length} answered` : '';
    }

    function pick(hash) {
      const u = urgentOpen();
      if (u && (!hash || hash === u.id)) { soloId = u.id; topicId = topicOf(u.id)?.id ?? null; return; }
      soloId = null;
      const t = (hash && topicOf(hash)) || openTopics().find((x) => x.open) || openTopics()[0];
      topicId = t ? t.id : null;
    }

    const sigNow = () => JSON.stringify([soloId, topicId, topics.map((t) => [t.id, t.state, t.open, t.answered]), visible().map((q) => [q.id, q.state, q.answers.length, q.answers.map((a) => Boolean(a.reply))])]);
    // One load at a time: a load waiting out a board restart would otherwise overlap the next poll's. A load asked for
    // while one runs shares it. → true when the board's answer landed in this view.
    let loading = null;
    let loaded = false;
    const load = (first) => (loading ||= fetchBoard(first).finally(() => { loading = null; }));
    async function fetchBoard(first) {
      const page = $('#page');
      try {
        const { body: d } = await fetchJSON(site.url('api/board'), { onWait: () => { if (first) page.innerHTML = restartNotice(); }, sleep: B.sleep });
        if (!B.alive()) return false;
        all = d.owner || [];
        items = d.items || [];
        topics = d.ownerTopics || [];
        site.syncBadge();
        if (first) pick(hashId());
        else if (soloId && byId(soloId)?.state !== 'open') pick('');
        else if (!topics.some((t) => t.id === topicId)) pick('');
        loaded = true;
        const sig = sigNow();
        const active = document.activeElement;
        if (sig !== shown && !(active && active.tagName === 'TEXTAREA')) {
          shown = sig;
          const y = scrollY;
          render();
          scrollTo(0, first ? 0 : y);
        }
        return true;
      } catch (e) {
        if (first) page.innerHTML = `<p class="muted">Could not load the questions: ${esc(e.message)}</p>`;
        return false;
      }
    }

    // After a Send from topic `from` whose pills stood as `pills` before it: stays while the topic has a question open,
    // else opens the pill that was to its left, else to its right, else any topic with an open question, else the board.
    function moveOn(from, pills, what) {
      soloId = null;
      const left = topics.find((t) => t.id === from)?.open || 0;
      if (needsOwner(from)) {
        topicId = from;
        sentLine = `${what} ${left} still open, answer ${left === 1 ? 'it' : 'them'} any time.`;
        shown = sigNow();
        const y = scrollY;
        render();
        scrollTo(0, y);
        return;
      }
      const at = pills.indexOf(from);
      const other = (id) => id !== from && needsOwner(id);
      const next = pills.slice(0, at).reverse().find(other) ?? pills.slice(at + 1).find(other) ?? topics.map((t) => t.id).find(other);
      sentLine = what;
      if (next === undefined) {
        sentNotice.put(B.route, what);
        if (ctx.up?.()) return;
        sentNotice.take(B.route);
        topicId = from;
      } else {
        topicId = next;
        const t = topics.find((x) => x.id === next);
        const first = t.questions.find((id) => byId(id)?.state === 'open') ?? t.questions[0];
        history.replaceState(history.state, '', '#' + encodeURIComponent(first));
      }
      shown = sigNow();
      render();
      scrollTo(0, 0);
    }

    B.on(root, 'click', (ev) => {
      if (ev.target.id === 'showAll') { soloId = null; sentLine = ''; shown = ''; render(); return; }
      const b = ev.target.closest && ev.target.closest('[data-topic]');
      if (b) { soloId = null; topicId = b.dataset.topic; sentLine = ''; shown = ''; render(); scrollTo(0, 0); }
    });
    B.on(root, 'change', (ev) => {
      const sec = ev.target.closest('section.q'); if (!sec || ev.target.type !== 'radio') return;
      const d = getDraft(sec.dataset.q); d.choice = ev.target.value; setDraft(sec.dataset.q, d); updateBar();
      sec.querySelectorAll('.take').forEach((t, i) => sec.querySelector(`[data-dot="${i}"]`)?.classList.toggle('picked', t.dataset.opt === ev.target.value));
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
      st.textContent = 'Sending…';
      const from = soloId ? topicOf(soloId)?.id : topicId;
      const pills = topicRow(topics, from).pills.map((t) => t.id);
      const name = topicName(topics.find((t) => t.id === from) || { title: '' });
      let sent = 0;
      try {
        for (const q of list) {
          const d = getDraft(q.id);
          const last = q.answers[q.answers.length - 1];
          const choice = d.choice ?? (last ? last.choice : null);
          const files = filesOf(q);
          await site.send('owner-answer', { id: q.id, question: q.question, choice, label: choiceLabel(q, choice), note: (d.note || '').trim(), ...(files.length ? { files } : {}) });
          setDraft(q.id, {});
          BoardAttach.clear('q:' + q.id, site.root);
          sent++;
        }
        const what = `Sent ${sent} answer${sent === 1 ? '' : 's'}${name ? ` to ${name}` : ''}.`;
        // A load that started before these answers went out would read them as still open.
        await loading;
        if (await load(false)) moveOn(from, pills, what);
        else if (B.alive()) { sentLine = what; $('#qstatus').textContent = what; $('#qstatus').classList.add('sent'); }
      } catch { st.textContent = sent ? `Sent ${sent} of ${list.length}. Is the Mac awake?` : 'Could not send. Is the Mac awake?'; }
    });
    // Each composer painted raises a bubbling attach-change (attach.js).
    B.on(root, 'attach-change', updateBar);
    // A link to another question here only moves the hash.
    B.on(window, 'hashchange', () => {
      if (!loaded) return;
      pick(hashId());
      sentLine = '';
      shown = '';
      render();
      scrollTo(0, 0);
    });

    load(true);
    B.every(15000, () => { if (!document.hidden) load(false); });
    B.on(document, 'visibilitychange', () => { if (!document.hidden) load(false); });
    // Back from a full-size take restores this page as it was, missing an answer sent there (prototype-switcher.js).
    B.on(window, 'pageshow', (ev) => { if (ev.persisted) { shown = ''; load(false); } });
  }),
};
