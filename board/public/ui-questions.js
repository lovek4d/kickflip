// Owner questions, for Waiting on you (view-questions.js). Needs ui.js and ui-links.js.
(function () {
  const { esc, escText, time, ago, replyBody, attachments, dropZone, protoButton, linkText, badge, opensHere, LINK_ARROW } = globalThis.BoardUI;
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
  // A question's unsent note: its draft, else on a reopened question the note its last answer sent, so a changed pick
  // sends it again.
  const noteOf = (q, draft) => draft.note ?? (q.reopened ? q.answers.at(-1)?.note || '' : '');
  // docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md
  // Whether the owner has resolved a question: an answer is sent, whatever Claude has done with it since, or Claude
  // resolved it. A sent question draws as resolvedCard, locked, until its badge reopens it.
  const isSent = (q) => q.state === 'answered' || q.state === 'replied' || q.state === 'resolved';
  // A question's unsent {choice, note} on this device, in localStorage under qdraft:<id>. view-questions.js and the
  // prototype viewer's Choose this (prototype-switcher.js) write it.
  const getDraft = (id) => { try { return JSON.parse(localStorage.getItem('qdraft:' + id) || '{}'); } catch { return {}; } };
  const setDraft = (id, v) => { try { localStorage.setItem('qdraft:' + id, JSON.stringify(v)); } catch {} };
  const suggestedLine = (q, o, links) => q.suggested?.option === o.id ? linkText(q.suggested.reason ?? `you answered this on ${q.suggested.card}: "${q.suggested.answer}"`, links) : '';

  const SPIN = '<span class="try-spin" aria-hidden="true"></span>';
  // A question's eye sends `prototype-request {key?, question, note, choice}` for that question alone, which then reads
  // requested until its prototype round arrives (view-questions.js).
  const questionEye = (q) => protoButton('q:' + q.id, { label: 'Ask for a prototype instead' });
  const noteComposer = (q, note) => `<div class="composer" data-composer="${esc('q:' + q.id)}">${dropZone(`<textarea class="note" rows="2" placeholder="Note (optional)">${esc(note || '')}</textarea>`)}
      <div class="note-tools">${questionEye(q)}<div class="pending-files" data-files></div></div></div>`;

  const QUESTION_STATE = {
    open: { label: 'open', tone: 'normal' },
    requested: { label: `${SPIN}prototype requested`, tone: 'normal' },
  };
  // docs/adr/2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md
  // A topic's latest prototype round from /api/board ownerTopics: {n, state: making|back|closed, take}.
  const roundChip = (r) => !r ? ''
    : r.state === 'making' ? badge('normal', `${SPIN}Prototype round ${r.n}`)
    : r.state === 'closed' ? badge('quiet', `Round ${r.n} closed · take ${esc(r.take)}`)
    : badge('normal', `Prototype round ${r.n}`);
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
  // A sent or resolved question, read-only in a green tint: its Resolved badge reopens it (view-questions.js sends
  // `question-reopen` once the owner confirms), how Claude resolved it and when (resolved_at), its last pick checked
  // among locked options, and its last note and Claude's reply. reask is a re-ask under way
  // (docs/adr/2026-11-04-2001-a-resolved-question-is-read-only-and-can-be-asked-again.md).
  function resolvedCard(q, links, n) {
    const last = q.answers[q.answers.length - 1];
    const outcome = q.resolved ? `${esc(q.resolved)}${/[.!?]$/.test(q.resolved) ? '' : '.'}` : '';
    const acted = q.resolved_at ? ` <span class="acted" title="${esc(time(q.resolved_at))}">acted on ${esc(ago(q.resolved_at))}</span>.` : '';
    const said = last && (last.note || last.reply || last.files?.length) ? `<div class="ans"><div class="muted small">You · ${esc(time(last.ts))}</div>${last.note ? `<div>${linkText(last.note, links)}</div>` : ''}${attachments(last.files)}</div>
      ${repliesOf(last, links)}` : '';
    return `<section class="q resolved" id="${esc(q.id)}" data-q="${esc(q.id)}">
      <div class="row" style="margin:0"><span class="muted small">${n ? n + '. ' : ''}${esc(q.source || '')}</span>${badge('ready', '✓ Resolved', { button: true, title: 'Reopen this question', attrs: { type: 'button', 'data-reopen': q.id } })}</div>
      <h3>${linkText(q.question, links)}</h3>
      ${q.answers.length ? '<div class="sent-line">Sent. Tap Resolved to reopen it.</div>' : ''}
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
  function questionCard(q, { n = 0, draft = {}, links = {} } = {}) {
    if (isSent(q)) return resolvedCard(q, links, n);
    const locked = q.state === 'requested';
    const chosen = locked ? q.request.choice : choiceOf(q, draft);
    return `<section class="q${q.urgent && q.state === 'open' ? ' urgent' : ''}${locked ? ' pr-busy' : ''}" id="${esc(q.id)}" data-q="${esc(q.id)}">
      <div class="row" style="margin:0"><span class="muted small">${n ? n + '. ' : ''}${esc(q.source || '')}</span>${badge(QUESTION_STATE[q.state].tone, QUESTION_STATE[q.state].label)}</div>
      <h3>${linkText(q.question, links)}</h3>
      ${q.context ? `<div class="ctx">${markdown(q.context, links)}</div>` : ''}
      ${questionLink(q.confirm_of && isPrototype(q.url) ? withParam(q.url, 'variant', q.options[0].id) : q.url)}
      ${confirmLine(q)}
      ${drawn(q) ? takes(q, chosen, links, locked) : q.options.map((o) => option(o, { name: 'c-' + q.id, checked: chosen === o.id, locked, suggested: suggestedLine(q, o, links), links })).join('')}
      ${locked ? (q.request.note ? `<div class="ans"><div class="muted small">You · ${esc(time(q.request.ts))}</div><div>${linkText(q.request.note, links)}</div></div>` : '') : noteComposer(q, noteOf(q, draft))}
      ${answerHistory(q, links)}
    </section>`;
  }
  // A pill reads its topic's title, a card's being its ref then its title, whichever tracker it comes from.
  const topicName = (t) => t.title;
  // /api/board's ownerTopics, each card's topic named from its card, which the board sends in its place while the card
  // is on the board (board/server.mjs pageBoard). cards: the board's items.
  function cardTopics(topics, cards) {
    const byKey = new Map(cards.map((c) => [c.key, c]));
    return topics.map((t) => {
      const c = t.title === undefined && byKey.get(t.card);
      return c ? { ...t, title: `${c.ref}: ${c.title}` } : t;
    });
  }
  // Topics from /api/board ownerTopics, in order. pills: unresolved topics with an open question, plus the
  // current topic wherever it stands; waiting: the other unresolved topics, which wait only on Claude.
  function topicRow(topics, current) {
    const pills = topics.filter((t) => t.id === current || (t.state !== 'resolved' && t.open > 0));
    const waiting = topics.filter((t) => t.id !== current && t.state !== 'resolved' && !(t.open > 0));
    return { pills, waiting };
  }

  // owner is in owner.json order; topics are the pills before the answer. A topic-wide Send omits answered.id.
  function nextQuestion(owner, topics, answered) {
    const at = owner.findIndex((q) => q.id === answered.id);
    const open = (q) => q.state === 'open' && q.id !== answered.id;
    const same = [...owner.slice(at + 1), ...owner.slice(0, Math.max(at, 0))].find((q) => q.topic === answered.topic && open(q));
    if (same) return same;
    const ids = topics.map((t) => t.id);
    const ti = ids.indexOf(answered.topic);
    const order = ti < 0 ? ids : [...ids.slice(0, ti).reverse(), ...ids.slice(ti + 1)];
    for (const id of order) {
      const q = owner.find((q) => q.topic === id && open(q));
      if (q) return q;
    }
    return owner.find(open) || null;
  }

  // The line a Send or prototype pick leaves for the board it goes back to, read once by that board's view (app.js).
  // Kept in sessionStorage, so a board opened later in another tab shows none.
  const noticeKey = (route) => 'sent:' + route;
  const sentNotice = {
    put(route, text) { try { sessionStorage.setItem(noticeKey(route), text); } catch {} },
    take(route) {
      try { const t = sessionStorage.getItem(noticeKey(route)) || ''; sessionStorage.removeItem(noticeKey(route)); return t; } catch { return ''; }
    },
  };

  // A prototype viewer's Round pill and its sheet (prototype-switcher.js). rounds: the card's prototype questions, oldest round first, as /api/board's card prototypes.rounds
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

  Object.assign(globalThis.BoardUI, { isPrototype, getDraft, setDraft, choiceLabel, choiceOf, noteOf, isSent, option, answerHistory, questionCard, roundChip, roundPill, roundSheet, topicName, cardTopics, topicRow, nextQuestion, sentNotice });
})();
