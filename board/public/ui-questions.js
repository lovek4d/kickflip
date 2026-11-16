// Owner questions, for Waiting on you (view-questions.js). Needs ui.js and ui-links.js.
(function () {
  const { esc, escText, time, ago, replyBody, attachments, dropZone, requestIcons, linkText, badge, opensHere, LINK_ARROW } = globalThis.BoardUI;
  // ui-markdown.js loads after this file, so markdown is looked up when a question draws.
  const markdown = (src, links) => globalThis.BoardUI.markdown(src, links);
  // A short id such as A or C2 leads the label; a word id such as "inline" would repeat it.
  const lead = (o) => (/^[A-Z][0-9]?$/i.test(o.id) ? `${o.id}. ` : '');
  const choiceLabel = (q, id) => { const o = q.options.find((x) => x.id === id); return o ? `${q.multi ? '' : lead(o)}${o.label}` : id || ''; };
  // suggested: the orchestrator's blue line under a suggested option's label, as HTML.
  const option = (o, { type = 'radio', name, checked = false, numbered = true, locked = false, suggested = '', links = {} }) => `<label class="opt"><input type="${type}" name="${esc(name)}" value="${esc(o.id)}" ${checked ? 'checked' : ''}${locked ? ' disabled' : ''}>
        <span><span class="lbl">${numbered ? escText(lead(o)) : ''}${escText(o.label)}</span>${o.recommended ? '<span class="rec">recommended</span>' : ''}${suggested ? `<div class="suggested-why">Orchestrator choice: ${suggested}</div>` : ''}<div class="det">${o.detail ? markdown(o.detail, links) : ''}</div></span></label>`;
  // docs/adr/2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md
  // A question's pick on this device: its unsent draft, else its last answer, else the option the overnight triage
  // suggested, pre-checked so the topic's Send sends it.
  const choiceOf = (q, draft) => 'choice' in draft ? draft.choice : (q.answers.length ? q.answers[q.answers.length - 1].choice : q.suggested?.option ?? null);
  // A question's unsent note: its draft.
  const noteOf = (q, draft) => draft.note ?? '';
  // docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md
  // Whether the owner has resolved a question: an answer is sent, whatever Claude has done with it since, or Claude
  // resolved it. A sent question draws as resolvedCard, locked.
  const isSent = (q) => q.state === 'answered' || q.state === 'replied' || q.state === 'resolved';
  // A question's unsent {choice, note} on this device, in localStorage under qdraft:<id>. view-questions.js and the
  // prototype viewer's Choose this (prototype-switcher.js) write it.
  const getDraft = (id) => { try { return JSON.parse(localStorage.getItem('qdraft:' + id) || '{}'); } catch { return {}; } };
  const setDraft = (id, v) => { try { localStorage.setItem('qdraft:' + id, JSON.stringify(v)); } catch {} };
  // docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md
  // The open questions among qs the owner has changed since their last answer, with files attached,
  // or with a suggested option pre-checked and never answered: the ones a Send sends. A sent one is read-only.
  function pendingAnswers(qs, filesOf) {
    return qs.filter((q) => q.state === 'open').filter((q) => {
      const d = getDraft(q.id);
      if (filesOf(q).length) return true;
      const last = q.answers[q.answers.length - 1];
      // A cleared pick sends only with a note.
      if ('choice' in d && d.choice === null) return Boolean(d.note);
      if (!last && q.suggested) return true;
      if (!('choice' in d) && !d.note) return false;
      return !last || (d.choice ?? last.choice) !== last.choice || (d.note || '') !== (last.note || '');
    });
  }
  // A question's answer as an owner-answers event sends it.
  function answerOf(q, files) {
    const choice = choiceOf(q, getDraft(q.id));
    return { id: q.id, question: q.question, choice, label: choiceLabel(q, choice), note: noteOf(q, getDraft(q.id)).trim(), ...(files.length ? { files } : {}) };
  }
  // The handlers that write a question's draft as the owner picks and types in root's forms, shared by Waiting on you and
  // the thread's questions sheet (on is a view's B.on); changed runs after each write. A radio can't be unchecked natively:
  // a pointer or Space press on a checked radio is noted, and its click clears it.
  function wireAnswerForm(on, root, changed) {
    const draftOf = (el) => { const sec = el.closest('section.q'); return sec && { id: sec.dataset.q, d: getDraft(sec.dataset.q) }; };
    let pressed = null;
    const radioOf = (el) => (el.type === 'radio' ? el : el.closest?.('label.opt')?.querySelector('input[type=radio]'));
    on(root, 'change', (ev) => {
      const at = ev.target.type === 'radio' && draftOf(ev.target); if (!at) return;
      at.d.choice = ev.target.value; setDraft(at.id, at.d); changed();
    });
    on(root, 'pointerdown', (ev) => { const r = radioOf(ev.target); pressed = r?.checked ? r : null; });
    on(root, 'keydown', (ev) => { if (ev.key === ' ' && ev.target.type === 'radio') pressed = ev.target.checked ? ev.target : null; });
    on(root, 'click', (ev) => {
      const at = ev.target.type === 'radio' && pressed === ev.target && draftOf(ev.target); if (!at) return;
      pressed = null;
      ev.target.checked = false;
      at.d.choice = null; setDraft(at.id, at.d); changed();
    });
    on(root, 'input', (ev) => {
      const at = ev.target.tagName === 'TEXTAREA' && draftOf(ev.target); if (!at) return;
      at.d.note = ev.target.value; setDraft(at.id, at.d); changed();
    });
    on(root, 'keydown', (ev) => {
      if (ev.target.tagName !== 'TEXTAREA') return;
      const form = ev.target.closest('form');
      if (!form || !globalThis.BoardUI.keyedSend(ev, form)) return;
      ev.preventDefault();
      form.requestSubmit();
    });
  }
  const suggestedLine = (q, o, links) => q.suggested?.option === o.id ? linkText(q.suggested.reason ?? `you answered this on ${q.suggested.card}: "${q.suggested.answer}"`, links) : '';

  const SPIN = '<span class="try-spin" aria-hidden="true"></span>';
  // docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md
  // Under the note box, the thread reply's row without What's left?: the files at the left, and at the right the eye,
  // fire, image and attach (ui.js requestIcons). The eye sends `prototype-request {key?, question, note, choice}` for that
  // question alone, which then reads requested until its prototype round arrives; the fire sends `grill-more` the same
  // way, which reads requested, Grilling deeper, until the grill's next questions resolve it, and the image `visual-request`,
  // the question staying open (app-questions-sheet.js).
  const noteComposer = (q, note) => `<div class="composer" data-composer="${esc('q:' + q.id)}">${dropZone(`<textarea class="note" rows="2" placeholder="Note (optional)">${esc(note || '')}</textarea>`, { attach: false })}
      <div class="note-tools"><div class="pending-files" data-files></div>${requestIcons('q:' + q.id, { protoLabel: 'Ask for a prototype instead' })}</div></div>`;

  const QUESTION_STATE = {
    open: { label: 'open', tone: 'normal' },
    requested: { label: `${SPIN}prototype requested`, tone: 'normal' },
  };
  const RULE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
  // Each of an answer's replies, oldest first.
  const repliesOf = (a, links) => (a.replies?.length ? a.replies : a.reply ? [a.reply] : []).map((r) => `<div class="rep${r.md ? ' md' : ''}"><div class="muted small">Claude</div>${replyBody(r, links)}</div>`).join('');
  function answerHistory(q, links = {}) {
    if (!q.answers.length) return '';
    const body = q.answers.map((a) => `<div class="ans"><div class="muted small">You · ${esc(time(a.ts))}</div>${escText(choiceLabel(q, a.choice))}${a.note ? `<div>${linkText(a.note, links)}</div>` : ''}${attachments(a.files)}</div>
      ${repliesOf(a, links)}`).join('');
    const last = q.answers[q.answers.length - 1];
    return q.state === 'open' || !last.reply ? body : `<details><summary>Your answer and Claude's reply</summary>${body}</details>`;
  }
  // A prototype page in the site's public/ is the question's full-page viewer: it opens in place, shows one take at a
  // time, and its switcher drafts a pick (board/public/prototype-switcher.js,
  // docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md).
  const PROTOTYPE_PAGE = /^prototype-[\w-]+\.html(?:[?#]|$)/;
  const isPrototype = (url) => Boolean(url) && PROTOTYPE_PAGE.test(globalThis.location && url.startsWith(location.origin + '/') ? url.replace(/^[^?#]*\//, '') : url);
  const withParam = (url, key, value) => {
    const at = url.includes('#') ? url.indexOf('#') : url.length;
    return `${url.slice(0, at)}${url.slice(0, at).includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}${url.slice(at)}`;
  };
  const questionLink = (url) => !url ? ''
    : isPrototype(url) ? `<a class="button proto-view" href="${esc(url)}">View prototypes</a>`
    : `<div class="small" style="margin-bottom:8px"><a href="${esc(url)}"${opensHere(url) ? '' : ' target="_blank" rel="noopener"'}>${esc(url.replace(/^https:\/\/(linear\.app\/[^/]+\/issue|github\.com)\//, ''))} ${LINK_ARROW}</a></div>`;

  // An option with `diagram` draws it with its `practice` in the question (docs/adr/2026-10-29-1639-a-questions-takes-show-inline.md).
  const drawn = (q) => q.options.some((o) => o.diagram);

  // rows: [[{text, tone?, to?}]], top to bottom. A box points at the boxes of the next row listed in `to`, else at all
  // of them; tone is a status colour's name.
  const TONES = ['quiet', 'info', 'notice', 'danger', 'success'];
  function diagram(rows) {
    const label = rows.map((row) => row.map((b) => b.text).join(', ')).join(' → ');
    return `<div class="flow" role="img" aria-label="${esc(label)}">${rows.map((row, i) => {
      const edges = i ? rows[i - 1].flatMap((b, from) => (b.to || row.map((_, n) => n)).map((to) => [from, to])) : [];
      const into = new Set(edges.map(([, to]) => to));
      const conn = edges.length ? `<svg class="flow-conn" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${edges.map(([from, to]) =>
        `<line x1="${((from + 0.5) / rows[i - 1].length) * 100}" y1="0" x2="${((to + 0.5) / row.length) * 100}" y2="100"/>`).join('')}</svg>` : '';
      return `${conn}<div class="flow-row${row.length > 3 ? ' dense' : ''}" style="grid-template-columns:repeat(${row.length},minmax(0,1fr))">${row.map((b, n) =>
        `<div class="flow-box${into.has(n) ? ' in' : ''}${TONES.includes(b.tone) ? ` tone-${b.tone}` : ''}">${esc(b.text)}</div>`).join('')}</div>`;
    }).join('')}</div>`;
  }
  const practice = (lines, links) => `<div class="practice"><b>In practice</b><ul>${lines.map((l) => `<li>${linkText(l, links)}</li>`).join('')}</ul></div>`;

  function takes(q, chosen, links, locked = false) {
    const name = 'c-' + q.id;
    return `<div class="takes">${q.options.map((o) => `<article class="take" data-opt="${esc(o.id)}">${option(o, { name, checked: chosen === o.id, locked, suggested: suggestedLine(q, o, links), links })}${o.diagram ? diagram(o.diagram) + practice(o.practice || [], links) : ''}</article>`).join('')}</div>`;
  }
  // A confirm says why it is asked; its View prototypes opens the viewer on its one take (?variant=).
  const confirmLine = (q) => q.confirm_of && q.state === 'open' ? `<div class="pr-rule">${RULE_ICON}A pick with a note gets a one-take confirm once Claude has updated the take.</div>` : '';
  // docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md
  // A sent or resolved question, read-only in a green tint: a plain Resolved badge, how Claude resolved it and when
  // (resolved_at), its last pick checked among locked options, and its last note and Claude's reply. reask is a re-ask under way
  // (docs/adr/2026-11-04-2001-a-resolved-question-is-read-only-and-can-be-asked-again.md).
  // sending: the answer outbox's entry for a question the board doesn't have the answer to yet (app-questions-sheet.js),
  // read-only with no badge, its sent line "<time> · sending…", or "<time> · not sent" with Retry and X
  // (docs/adr/2026-11-16-0500-each-answered-question-shows-at-once-as-sending.md).
  function resolvedCard(q, links, n, sending = null) {
    const last = q.answers[q.answers.length - 1];
    const sentLine = sending ? `<div class="sent-line sending"><span>${esc(time(sending.ts))}</span><span>·</span>${globalThis.BoardUI.pickUp({ state: sending.failed ? 'failed' : 'sending', sendId: sending.sendId })}</div>`
      : q.answers.length ? '<div class="sent-line">Sent.</div>' : '';
    const outcome = q.resolved ? `${esc(q.resolved)}${/[.!?]$/.test(q.resolved) ? '' : '.'}` : '';
    const acted = q.resolved_at ? ` <span class="acted" title="${esc(time(q.resolved_at))}">acted on ${esc(ago(q.resolved_at))}</span>.` : '';
    const said = last && (last.note || last.reply || last.files?.length) ? `<div class="ans"><div class="muted small">You · ${esc(time(last.ts))}</div>${last.note ? `<div>${linkText(last.note, links)}</div>` : ''}${attachments(last.files)}</div>
      ${repliesOf(last, links)}` : '';
    return `<section class="q resolved" id="${esc(q.id)}" data-q="${esc(q.id)}">
      <div class="row" style="margin:0"><span class="muted small">${n ? n + '. ' : ''}${esc(q.source || '')}</span>${sending ? '' : badge('ready', '✓ Resolved')}</div>
      <h3>${linkText(q.question, links)}</h3>
      ${sentLine}
      ${q.context ? `<div class="ctx">${markdown(q.context, links)}</div>` : ''}
      ${questionLink(q.url)}
      ${outcome || acted ? `<div class="small muted resolved-line">${outcome}${acted}</div>` : ''}
      ${q.options.map((o) => option(o, { name: 'c-' + q.id, checked: last?.choice === o.id, locked: true, links })).join('')}
      ${said}
      ${q.reask ? '<div class="small muted reask-line">re-ask requested</div>' : ''}
    </section>`;
  }
  // An owner question from /api/board; draft is this device's unsent {choice, note}; links its ui-links.js linkContext.
  // A question waiting on the prototype the owner asked for is locked at the pick and note the request sent until its
  // round arrives (docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md).
  // A requested question takes the accent tint, as a sent one takes the green.
  // sending: the question's entry in the answer outbox, which draws it as resolvedCard does with that answer.
  function questionCard(q, { n = 0, draft = {}, links = {}, sending = null } = {}) {
    if (sending) return resolvedCard({ ...q, answers: [...q.answers, { ts: sending.ts, choice: sending.answer.choice, note: sending.answer.note, files: sending.answer.files }] }, links, n, sending);
    if (isSent(q)) return resolvedCard(q, links, n);
    const locked = q.state === 'requested';
    const chosen = locked ? q.request.choice : choiceOf(q, draft);
    return `<section class="q${q.urgent && q.state === 'open' ? ' urgent' : ''}${locked ? ' pr-busy' : ''}" id="${esc(q.id)}" data-q="${esc(q.id)}">
      <div class="row" style="margin:0"><span class="muted small">${n ? n + '. ' : ''}${esc(q.source || '')}</span>${badge(QUESTION_STATE[q.state].tone, q.state === 'requested' && q.request.kind === 'grill-more' ? `${SPIN}Grilling deeper` : QUESTION_STATE[q.state].label)}</div>
      <h3>${linkText(q.question, links)}</h3>
      ${q.context ? `<div class="ctx">${markdown(q.context, links)}</div>` : ''}
      ${questionLink(q.confirm_of && isPrototype(q.url) ? withParam(q.url, 'variant', q.options[0].id) : q.url)}
      ${confirmLine(q)}
      ${drawn(q) ? takes(q, chosen, links, locked) : q.options.map((o) => option(o, { name: 'c-' + q.id, checked: chosen === o.id, locked, suggested: suggestedLine(q, o, links), links })).join('')}
      ${locked ? (q.request.note ? `<div class="ans"><div class="muted small">You · ${esc(time(q.request.ts))}</div><div>${linkText(q.request.note, links)}</div></div>` : '') : noteComposer(q, noteOf(q, draft))}
      ${answerHistory(q, links)}
    </section>`;
  }
  // /api/board's ownerTopics, each card's topic named from its card, which the board sends in its place while the card
  // is on the board (board/server.mjs pageBoard). cards: the board's items.
  function cardTopics(topics, cards) {
    const byKey = new Map(cards.map((c) => [c.key, c]));
    return topics.map((t) => {
      const c = t.title === undefined && byKey.get(t.card);
      return c ? { ...t, title: `${c.ref}: ${c.title}` } : t;
    });
  }
  // docs/adr/2026-11-14-2330-the-questions-page-is-one-queue-of-what-the-badge-counts.md
  // The ? page's rows and its count, which the header's badge reads too, so the two agree: the board's queue (what
  // waits on the owner, oldest first) with each question entry as its topic with an open question, {topic}, and each
  // tap as {tap}; a topic the queue doesn't name follows, in the topics' order. topics: /api/board's, named by cardTopics.
  // outbox: this browser's unsent taps (app-threads.js); a card whose Implement or Done is in it, queued or in flight,
  // has no tap row, the row following the tap rather than the board's answer, and returns if the board refuses the
  // tap and it leaves the outbox (docs/adr/2026-11-15-1400-waiting-on-you-follows-the-tap-not-the-board.md).
  // answering: the answer outbox's entries whose question is still open on the board (unsentAnswers): a topic counts
  // only its open questions not among them, and with none has no row
  // (docs/adr/2026-11-16-0500-each-answered-question-shows-at-once-as-sending.md).
  function queueRows(queue, topics, outbox = [], answering = []) {
    const open = topics.map((t) => ({ ...t, open: t.open - answering.filter((m) => m.topic === t.id).length })).filter((t) => t.state !== 'resolved' && t.open > 0);
    const tapped = new Set(outbox.filter((m) => m.intent === 'build' || m.kind === 'card-done').map((m) => m.key));
    const rows = [];
    for (const entry of queue || []) {
      if (entry.kind !== 'question') { if (!tapped.has(entry.key)) rows.push({ tap: entry }); }
      else { const topic = open.find((t) => t.id === entry.id); if (topic) rows.push({ topic }); }
    }
    return [...rows, ...open.filter((t) => !rows.some((r) => r.topic === t)).map((topic) => ({ topic }))];
  }
  // A prototype viewer's Round pill and its sheet, on the full page (prototype-switcher.js) and in the board's right pane
  // (app-pane.js). rounds: the card's prototype questions, oldest round first, as /api/board's card prototypes.rounds
  // lists them ({n, q, url, confirm, state}). The pill names the round qid is in, out of the newest round's number; a
  // card with a single round gets none.
  function roundPill(rounds, qid) {
    const at = (rounds || []).find((r) => r.q === qid);
    if (!at || rounds.length < 2) return '';
    return `<button type="button" class="ps-chip" data-ps-top="rounds">Round ${at.n} of ${Math.max(...rounds.map((r) => r.n))} · earlier</button>`;
  }
  const ROUND_WORD = { open: 'open', requested: 'prototype requested' };
  function roundSheet({ ref, rounds, qid }) {
    const rows = [...rounds].reverse().map((r) => `<button type="button" data-ps-round="${esc(r.url)}"><span>Round ${r.n}${r.confirm ? ' confirm' : ''}${r.q === qid ? ' · showing' : ''}</span><span>${ROUND_WORD[r.state] || 'answered'}</span></button>`);
    return `<div class="ps-sheet" role="dialog" aria-label="Rounds"><h3>Rounds on ${esc(ref)}</h3>${rows.join('')}</div>`;
  }

  // The outbox changing, for the views drawing rows from it: each listener runs after the outbox is written.
  const outboxListeners = new Set();
  const onOutbox = (fn) => { outboxListeners.add(fn); return () => outboxListeners.delete(fn); };
  const outboxChanged = () => outboxListeners.forEach((fn) => fn());
  // The answer outbox: the questions sheet's answers the board hasn't recorded yet, kept in this browser under the board's
  // own keys (app-questions-sheet.js). unsentAnswers: its entries whose question owner (/api/board's) still has open.
  const ANSWER_OUTBOX = 'answer-outbox';
  const unsentAnswers = (owner, store) => store.get(ANSWER_OUTBOX, []).filter((m) => (owner || []).some((q) => q.id === m.id && q.state === 'open'));

  Object.assign(globalThis.BoardUI, { onOutbox, outboxChanged, ANSWER_OUTBOX, unsentAnswers, isPrototype, getDraft, setDraft, choiceLabel, choiceOf, noteOf, isSent, pendingAnswers, answerOf, wireAnswerForm, option, answerHistory, questionCard, roundPill, roundSheet, cardTopics, queueRows });
})();
