// Waiting on you, /<route>/questions.html#<question id>, a view of the app shell (shell.js). A topic's questions show
// on one page with one Send at the bottom, which sends an `owner-answer` event per question answered there; the rest
// stay open for a later visit. Once every answer has sent, a topic with a question still open stays; one with none
// opens the topic whose pill was to its left before the Send, else to its right, and with no topic left that has an
// open question goes back to the board, where the Sent line shows as a toast (BoardUI.sentNotice). An open question
// with `urgent: true` in owner.json shows alone first, and its Send follows the same rule for its topic. A question
// whose options are prototype takes frames each take with ?take= (docs/adr/0048-a-questions-takes-show-inline.md).
// Each question's eye sends `prototype-request {key?, question, note, choice}` for that question instead of an answer,
// with its note box as the note and its pick so far as the choice (docs/adr/0126-each-question-has-its-own-prototype-eye.md).
// The board server resolves the question with it, and once it is recorded the page moves on as a Send does
// (docs/adr/0177-a-question-asked-for-a-prototype-is-resolved.md).
// fits: each framed take's measured size, kept across repaints and visits so a take redraws at its size at once.
(globalThis.AppViews ||= {}).questions = ((fits) => ({
  className: 'view-questions',
  title: () => 'Waiting On You',
  markup: () => `${BoardUI.header({ lead: 'back', title: 'Waiting on you', controls: false, trail: '<span class="muted small" id="progress"></span>' })}
<main>
  <section id="page"></section>
</main>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
    const { $, site } = B;
    const { esc, choiceLabel, questionCard, roundChip, takes, linkContext, badge, topicName, topicRow, nextQuestion, sentNotice, fetchJSON, restartNotice } = BoardUI;
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
    let scrollTake = null;
    const takeResources = new Map();
    const clearTakeResources = (within = root) => {
      for (const [shot, release] of takeResources) {
        if (!shot.isConnected || within.contains(shot)) { release(); takeResources.delete(shot); }
      }
    };
    B.atUnmount(() => clearTakeResources());

    const byId = (id) => all.find((q) => q.id === id);
    const topicOf = (qid) => topics.find((t) => t.questions.includes(qid)) || null;
    const openTopics = () => topics.filter((t) => t.state !== 'resolved');
    const links = (q) => linkContext(items, q.topic?.startsWith('item:') ? q.topic.slice(5) : null, { base: './' });
    const urgentOpen = () => all.find((q) => q.urgent && q.state === 'open');

    // docs/adr/0038-waiting-on-you-leads-with-what-needs-the-owner.md
    function topicBar() {
      const list = topicRow(topics, topicId).pills;
      if (list.length < 2) return '';
      return `<div class="topics" role="group" aria-label="Topics">${list.map((t) =>
        `<button data-topic="${esc(t.id)}" aria-pressed="${t.id === topicId}" title="${esc(t.title)}">${esc(topicName(t))}<span class="n">${t.state === 'resolved' ? 'resolved' : t.open}</span></button>`).join('')}</div>`;
    }
    const topicHead = (t) => t ? `<div class="topichead muted small"><span>${esc(t.title)}${t.summary ? ` · ${esc(t.summary)}` : ''}</span>${roundChip(t.round)}</div>` : '';

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
      clearTakeResources();
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
        ${live.map((q, i) => questionCard(q, { n: soloId ? 0 : i + 1, draft: getDraft(q.id), links: links(q), fit: fitOf(q) })).join('')}
        ${done.length ? `<details class="done"><summary>Resolved · ${done.length}</summary>${done.map((q) => questionCard(q, { draft: getDraft(q.id), links: links(q), fit: fitOf(q) })).join('')}</details>` : ''}
        <div class="bar"><span class="muted small${sentLine ? ' sent' : ''}" id="qstatus" role="status">${esc(sentLine)}</span><span class="send-hint" aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘↵' : 'Ctrl+↵'}</span><button class="primary" type="submit" id="send">Send</button></div>
      </form>${soloId ? '' : waitingTopics() + resolvedTopics()}`;
      BoardAttach.paintAll();
      el.querySelectorAll('.take-shot').forEach(fitTake);
      updateBar();
    }

    // A width sets its page's height, so a size measured at another width is measured again.
    const fitKey = (qid, oid) => `${site.root}\n${qid}\n${oid}`;
    const fitOf = (q) => (oid) => { const f = fits.get(fitKey(q.id, oid)); return f && f.w === window.innerWidth ? f : null; };
    // A phone's header is a bar at the bottom (docs/adr/0070-phone-headers-sit-at-the-bottom.md), so only a header
    // at the top covers the frame's top.
    const frameTop = (shot) => {
      const head = $('header.top')?.getBoundingClientRect();
      const over = head && head.top < innerHeight / 2 ? head.bottom : 0;
      return Math.max(0, scrollY + shot.getBoundingClientRect().top - over);
    };
    function repaintTakes(sec) {
      if (!sec.querySelector('.takes')) return;
      const q = byId(sec.dataset.q);
      const d = getDraft(q.id);
      const chosen = d.choice ?? q.answers[q.answers.length - 1]?.choice;
      const old = sec.querySelector('.takes');
      clearTakeResources(old);
      old.outerHTML = takes(q, chosen, links(q), fitOf(q));
      sec.querySelectorAll('.take-shot').forEach(fitTake);
    }

    // A full-screen take gets the screen between the header and the Send bar.
    const screenH = () => Math.max(320, innerHeight - ($('header.top')?.offsetHeight || 0) - ($('#qform .bar')?.offsetHeight || 0));

    // A framed take is sized to its page once it loads, since the frame can't scroll. A page that fills its frame at
    // any height is a full-screen take and gets screenH. A full-screen take, or a grid take past 80% of the screen's
    // height, turns its question into one full-width take under a choice row
    // (docs/adr/0048-a-questions-takes-show-inline.md).
    function fitTake(shot) {
      const frame = shot.querySelector('iframe');
      const sec = shot.closest('section.q');
      // A switch in place (inPlace) changes the take a frame shows, and so the key its size is kept under.
      const key = () => fitKey(sec.dataset.q, shot.closest('.take').dataset.opt);
      const full = Boolean(shot.closest('.takes-full'));
      let watcher = null;
      let probing = false;
      let raf = 0;
      const measure = () => {
        try {
          const doc = frame.contentDocument;
          // The body's own height: the document's scrollHeight never drops below the frame's.
          return doc?.body && doc.location.href !== 'about:blank' ? Math.ceil(doc.body.getBoundingClientRect().height) : null;
        } catch { return null; }
      };
      const sizeNow = () => { const f = fits.get(key()); return f?.w === window.innerWidth ? { ...f } : { w: window.innerWidth }; };
      const fillsFrame = (h) => Math.abs(h - frame.clientHeight) <= 1;
      // A page as tall as its frame is grown once: a page sized by its content keeps its height, a full-screen one
      // follows the frame.
      const probe = () => {
        probing = true;
        shot.style.height = `${frame.clientHeight + 202}px`;
        raf = requestAnimationFrame(() => raf = requestAnimationFrame(() => {
          raf = 0;
          probing = false;
          const h = measure();
          if (h === null || !shot.isConnected || !B.alive()) return;
          fits.set(key(), { ...sizeNow(), fills: fillsFrame(h) });
          apply();
        }));
      };
      const apply = () => {
        if (probing) return;
        const h = measure();
        if (h === null || !shot.isConnected || !B.alive()) return;
        const size = sizeNow();
        if (size.fills === undefined) {
          if (fillsFrame(h)) { probe(); return; }
          size.fills = false;
        }
        // The shot's border is 1px each side, and the frame fills the rest.
        const height = size.fills ? screenH() : h + 2;
        if (full) size.fullH = height;
        else { size.h = height; size.scrolls = size.fills || h > window.innerHeight * 0.8; }
        fits.set(key(), size);
        const q = byId(sec.dataset.q);
        if (!full && size.scrolls && q.options.every((o) => !o.diagram && !o.practice)) {
          repaintTakes(sec);
          return;
        }
        shot.style.height = `${height}px`;
        shot.classList.remove('measuring');
        if (scrollTake === shot) { scrollTo(0, frameTop(shot)); scrollTake = null; }
      };
      const off = B.on(frame, 'load', () => {
        if (measure() === null || !B.alive()) return;
        watcher?.disconnect();
        watcher = null;
        apply();
        // A page that grows after it loads, or narrows with the view, is measured again.
        if (!shot.isConnected) return;
        try {
          watcher = new frame.contentWindow.ResizeObserver(apply);
          watcher.observe(frame.contentDocument.body);
        } catch {}
      });
      takeResources.set(shot, () => { off(); watcher?.disconnect(); if (raf) cancelAnimationFrame(raf); });
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

    // The topic a tap on this page acts for, the pills before it and its name, which moveOn reads once it is recorded.
    function leaving() {
      const from = soloId ? topicOf(soloId)?.id : topicId;
      return { from, pills: topicRow(topics, from).pills, name: topicName(topics.find((t) => t.id === from) || { title: '' }) };
    }
    // After a recorded tap: a load that started before it went out would read its question as still open.
    async function moveOnOnceLoaded({ from, pills }, what) {
      await loading;
      if (await load(false)) moveOn(from, pills, what);
      else if (B.alive()) { sentLine = what; $('#qstatus').textContent = what; $('#qstatus').classList.add('sent'); }
    }

    async function askPrototype(q) {
      const st = $('#qstatus');
      const key = q.topic?.startsWith('item:') ? q.topic.slice(5) : null;
      const at = leaving();
      st.textContent = 'Sending…';
      const d = getDraft(q.id);
      const last = q.answers[q.answers.length - 1];
      try { await site.send('prototype-request', { ...(key ? { key } : {}), question: q.id, note: (d.note || '').trim(), choice: d.choice ?? (last ? last.choice : null) }); }
      catch (e) { st.textContent = e.reason ? `Nothing was sent: ${e.reason}` : 'Could not send. Is the host awake?'; return; }
      setDraft(q.id, {});
      await moveOnOnceLoaded(at, `Prototype requested${at.name ? ` for ${at.name}` : ''}.`);
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

    const sigNow = () => JSON.stringify([soloId, topicId, topics.map((t) => [t.id, t.state, t.open, t.answered, t.round]), visible().map((q) => [q.id, q.state, q.answers.length, q.answers.map((a) => Boolean(a.reply))])]);
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

    function moveOn(from, pills, what) {
      soloId = null;
      const next = nextQuestion(all, pills, { topic: from });
      const left = topics.find((t) => t.id === from)?.open || 0;
      if (next?.topic === from) {
        topicId = from;
        sentLine = `${what} ${left} still open, answer ${left === 1 ? 'it' : 'them'} any time.`;
        shown = sigNow();
        const y = scrollY;
        render();
        scrollTo(0, y);
        return;
      }
      sentLine = what;
      if (!next) {
        sentNotice.put(B.route, what);
        if (ctx.up?.()) return;
        sentNotice.take(B.route);
        topicId = from;
      } else {
        topicId = next.topic;
        history.replaceState(history.state, '', '#' + encodeURIComponent(next.id));
      }
      shown = sigNow();
      render();
      scrollTo(0, 0);
    }

    B.on(root, 'click', (ev) => {
      if (ev.target.id === 'showAll') { soloId = null; sentLine = ''; shown = ''; render(); return; }
      const eye = ev.target.closest && ev.target.closest('[data-proto]');
      if (eye) { askPrototype(byId(eye.closest('section.q').dataset.q)); return; }
      const b = ev.target.closest && ev.target.closest('[data-topic]');
      if (b) { soloId = null; topicId = b.dataset.topic; sentLine = ''; shown = ''; render(); scrollTo(0, 0); }
    });
    // The full-width frame shows another take without reloading, where its page's switcher can
    // (prototype-switcher.js current.go), so the page keeps its place. → false when it can't.
    function inPlace(full, choice) {
      const take = full.querySelector('.take');
      const frame = take?.querySelector('iframe');
      let sw = null;
      try { sw = frame?.contentWindow?.PrototypeSwitcher?.current; } catch { sw = null; }
      if (!sw?.go || !sw.takes?.includes(choice)) return false;
      sw.go(choice);
      take.dataset.opt = choice;
      for (const label of full.querySelectorAll('.take-choices .opt')) {
        if (label.querySelector('input')?.value === choice) label.setAttribute('aria-current', 'true');
        else label.removeAttribute('aria-current');
      }
      return true;
    }
    B.on(root, 'change', (ev) => {
      const sec = ev.target.closest('section.q'); if (!sec || ev.target.type !== 'radio') return;
      const d = getDraft(sec.dataset.q); d.choice = ev.target.value; setDraft(sec.dataset.q, d); updateBar();
      const full = sec.querySelector('.takes-full');
      if (full && inPlace(full, d.choice)) return;
      if (full) {
        const top = frameTop(full.querySelector('.take-shot'));
        repaintTakes(sec);
        scrollTake = sec.querySelector('.take-shot');
        sec.querySelector(`input[value="${CSS.escape(d.choice)}"]`)?.focus({ preventScroll: true });
        scrollTo(0, top);
      }
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
      const at = leaving();
      // docs/adr/0163-send-records-every-ready-answer-in-one-request.md: one request, recorded all or none.
      const answers = list.map((q) => {
        const d = getDraft(q.id);
        const last = q.answers[q.answers.length - 1];
        const choice = d.choice ?? (last ? last.choice : null);
        const files = filesOf(q);
        return { id: q.id, question: q.question, choice, label: choiceLabel(q, choice), note: (d.note || '').trim(), ...(files.length ? { files } : {}) };
      });
      try { await site.send('owner-answers', { answers }); }
      catch (e) { st.textContent = e.reason ? `Nothing was sent: ${e.reason}` : 'Could not send. Is the host awake?'; return; }
      for (const q of list) {
        setDraft(q.id, {});
        BoardAttach.clear('q:' + q.id, site.root);
      }
      await moveOnOnceLoaded(at, `Sent ${list.length} answer${list.length === 1 ? '' : 's'}${at.name ? ` to ${at.name}` : ''}.`);
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
    // An answer sent from a standalone prototype is reloaded when this page returns from the browser cache.
    B.on(window, 'pageshow', (ev) => { if (ev.persisted) { shown = ''; load(false); } });
    // A new width needs grid measurements before choosing either layout again.
    let width = window.innerWidth;
    B.on(window, 'resize', () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      root.querySelectorAll('section.q').forEach(repaintTakes);
    });
  }),
}))(new Map());
