// Owner questions, for Waiting on you (view-questions.js). Needs ui.js and ui-links.js.
(function () {
  const { esc, time, ago, replyBody, attachments, attachButton, dropZone, protoButton, linkText, linkHtml, badge, opensHere, LINK_ARROW } = globalThis.BoardUI;
  // A short id such as A or C2 leads the label; a word id such as "inline" would repeat it. prototype-switcher.js answerLabel matches.
  const lead = (o) => (/^[A-Z][0-9]?$/i.test(o.id) ? `${o.id}. ` : '');
  const choiceLabel = (q, id) => { const o = q.options.find((x) => x.id === id); return o ? `${q.multi ? '' : lead(o)}${o.label}` : id || ''; };
  // suggested: the line under a suggested option saying where the owner chose it before, as HTML.
  const option = (o, { type = 'radio', name, checked = false, numbered = true, shown = false, locked = false, suggested = '' }) => `<label class="opt"${shown ? ' aria-current="true"' : ''}><input type="${type}" name="${esc(name)}" value="${esc(o.id)}" ${checked ? 'checked' : ''}${locked ? ' disabled' : ''}>
        <span><span class="lbl">${numbered ? esc(lead(o)) : ''}${esc(o.label)}</span>${suggested ? badge('ready', 'suggested').replace('class="chip', 'class="chip suggested') : ''}${o.recommended ? '<span class="rec">recommended</span>' : ''}<div class="det">${esc(o.detail || '')}</div>${suggested ? `<div class="suggested-why">${suggested}</div>` : ''}</span></label>`;
  // docs/adr/2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md
  // A question's pick on this device: its unsent draft, else its last answer, else the option the overnight triage
  // suggested, pre-checked so the topic's Send sends it.
  const choiceOf = (q, draft) => draft.choice ?? (q.answers.length ? q.answers[q.answers.length - 1].choice : q.suggested?.option ?? null);
  const suggestedLine = (q, o, links) => q.suggested?.option === o.id ? linkText(`You answered this on ${q.suggested.card}: "${q.suggested.answer}"`, links) : '';

  const SPIN = '<span class="try-spin" aria-hidden="true"></span>';
  // A question's eye sends `prototype-request {key?, question, note, choice}` for that question alone, which then reads
  // requested until its prototype round arrives (view-questions.js).
  const questionEye = (q) => protoButton('q:' + q.id, { label: 'Ask for a prototype instead' });
  const noteComposer = (q, note) => `<div class="composer" data-composer="${esc('q:' + q.id)}">${dropZone(`<textarea class="note" rows="2" placeholder="Note (optional)">${esc(note || '')}</textarea>`)}
      <div class="note-tools">${attachButton()}${questionEye(q)}<div class="pending-files" data-files></div></div></div>`;

  const QUESTION_STATE = {
    open: { label: 'open', tone: 'normal' },
    answered: { label: 'waiting for claude', tone: 'notice' },
    replied: { label: 'claude replied', tone: 'ready' },
    requested: { label: `${SPIN}prototype requested`, tone: 'normal' },
  };
  // docs/adr/2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md
  // A topic's latest prototype round from /api/board ownerTopics: {n, state: making|back|closed, take}.
  const roundChip = (r) => !r ? ''
    : r.state === 'making' ? badge('normal', `${SPIN}Prototype round ${r.n}`)
    : r.state === 'closed' ? badge('quiet', `Round ${r.n} closed · take ${esc(r.take)}`)
    : badge('normal', `Prototype round ${r.n}`);
  const RULE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
  function answerHistory(q, links = {}) {
    if (!q.answers.length) return '';
    const body = q.answers.map((a) => `<div class="ans"><div class="muted small">You · ${esc(time(a.ts))}</div>${esc(choiceLabel(q, a.choice))}${a.note ? `<div>${linkText(a.note, links)}</div>` : ''}${attachments(a.files)}</div>
      ${a.reply ? `<div class="rep"><div class="muted small">Claude</div>${linkHtml(replyBody(a.reply), links)}</div>` : a.acted ? '' : '<div class="muted small" style="margin-top:4px">Waiting for Claude…</div>'}`).join('');
    const last = q.answers[q.answers.length - 1];
    return q.state === 'open' || !last.reply ? body : `<details><summary>Your answer and Claude's reply</summary>${body}</details>`;
  }
  // A prototype page in the site's public/ opens in place, and its switcher picks a take (board/public/prototype-switcher.js).
  const PROTOTYPE_PAGE = /^prototype-[\w-]+\.html(?:[?#]|$)/;
  const isPrototype = (url) => Boolean(url) && PROTOTYPE_PAGE.test(globalThis.location && url.startsWith(location.origin + '/') ? url.replace(/^[^?#]*\//, '') : url);
  const withParam = (url, key, value) => {
    const at = url.includes('#') ? url.indexOf('#') : url.length;
    return `${url.slice(0, at)}${url.slice(0, at).includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}${url.slice(at)}`;
  };
  const questionLink = (url) => !url ? ''
    : isPrototype(url) ? `<a class="pill proto" href="${esc(url)}">See the prototypes →</a>`
    : `<div class="small" style="margin-bottom:8px"><a href="${esc(url)}"${opensHere(url) ? '' : ' target="_blank" rel="noopener"'}>${esc(url.replace(/^https:\/\/(linear\.app\/[^/]+\/issue|github\.com)\//, ''))} ${LINK_ARROW}</a></div>`;

  // A question's takes show inline (docs/adr/2026-10-29-1639-a-questions-takes-show-inline.md): an option with `diagram` draws
  // it with its `practice`, and on a question whose url is a prototype page any other option shows that page's take.
  const framed = (q) => isPrototype(q.url) && q.options.some((o) => !o.diagram);
  const inline = (q) => isPrototype(q.url) || q.options.some((o) => o.diagram);

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

  const fullTakes = (q, fit) => isPrototype(q.url) && q.options.every((o) => !o.diagram && !o.practice)
    && (q.options.length === 1 || q.options.some((o) => fit(o.id)?.scrolls));
  // Grid heights decide the layout; fullH measures the chosen take at the full content width.
  function takeBody(q, o, links, fit, full = false) {
    if (o.diagram) return diagram(o.diagram) + practice(o.practice || [], links);
    if (!isPrototype(q.url)) return '';
    const size = fit(o.id);
    const h = full ? size?.fullH : size?.h;
    // Every take loads so one outside the viewport can still decide the question's layout.
    return `<div class="take-shot${h ? '' : ' measuring'}"${h ? ` style="height:${Math.round(h)}px"` : ''}><iframe src="${esc(withParam(q.url, 'take', o.id))}" title="${esc(o.label)}"></iframe></div>`;
  }
  function takes(q, chosen, links, fit, locked = false) {
    const name = 'c-' + q.id;
    if (fullTakes(q, fit)) {
      const shown = q.options.find((o) => o.id === chosen) || q.options.find((o) => o.recommended) || q.options[0];
      return `<div class="takes takes-full"><div class="take-choices" role="group" aria-label="Takes">${q.options.map((o) => option(o, { name, checked: chosen === o.id, shown: o === shown, locked, suggested: suggestedLine(q, o, links) })).join('')}</div><article class="take" data-opt="${esc(shown.id)}">${takeBody(q, shown, links, fit, true)}</article></div>`;
    }
    return `<div class="takes">${q.options.map((o) => `<article class="take" data-opt="${esc(o.id)}">${option(o, { name, checked: chosen === o.id, locked, suggested: suggestedLine(q, o, links) })}${takeBody(q, o, links, fit)}</article>`).join('')}</div>`;
  }
  // A confirm links its one take alone, and says why it is asked.
  const confirmLines = (q) => !q.confirm_of ? ''
    : `<a class="pill proto pr-open" href="${esc(withParam(q.url, 'take', q.options[0].id))}">Open the prototype →</a>${q.state === 'open' ? `<div class="pr-rule">${RULE_ICON}A pick with a note gets a one-take confirm once Claude has updated the take.</div>` : ''}`;
  // docs/adr/2026-11-04-2001-a-resolved-question-is-read-only-and-can-be-asked-again.md
  // A resolved question, read-only: its green resolved badge asks Claude to ask it again (view-questions.js sends
  // `reask-request` once the owner confirms), how it was resolved and when it was acted on (resolved_at), its last pick
  // checked among locked options, and its last note and Claude's reply. reask is a re-ask under way, which locks the badge.
  function resolvedCard(q, links) {
    const last = q.answers[q.answers.length - 1];
    const outcome = q.resolved ? `${esc(q.resolved)}${/[.!?]$/.test(q.resolved) ? '' : '.'}` : '';
    const acted = q.resolved_at ? ` <span class="acted" title="${esc(time(q.resolved_at))}">acted on ${esc(ago(q.resolved_at))}</span>.` : '';
    const said = last && (last.note || last.reply || last.files?.length) ? `<div class="ans"><div class="muted small">You · ${esc(time(last.ts))}</div>${last.note ? `<div>${linkText(last.note, links)}</div>` : ''}${attachments(last.files)}</div>
      ${last.reply ? `<div class="rep"><div class="muted small">Claude</div>${linkHtml(replyBody(last.reply), links)}</div>` : ''}` : '';
    return `<section class="q resolved" id="${esc(q.id)}" data-q="${esc(q.id)}">
      <div class="row" style="margin:0"><span class="muted small">${esc(q.source || '')}</span>${badge('ready', 'resolved', { button: true, title: 'Ask this question again', attrs: { type: 'button', 'data-reask': q.id, disabled: q.reask ? '' : null } })}</div>
      <h3>${linkText(q.question, links)}</h3>
      ${q.context ? `<div class="ctx">${linkText(q.context, links)}</div>` : ''}
      ${questionLink(q.url)}
      ${outcome || acted ? `<div class="small muted resolved-line">${outcome}${acted}</div>` : ''}
      ${q.options.map((o) => option(o, { name: 'c-' + q.id, checked: last?.choice === o.id, locked: true })).join('')}
      ${said}
      ${q.reask ? '<div class="small muted reask-line">re-ask requested</div>' : ''}
    </section>`;
  }
  // An owner question from /api/board; draft is this device's unsent {choice, note}; links its ui-links.js linkContext;
  // fit(option id) supplies the measured grid and full-width heights.
  // A question waiting on the prototype the owner asked for is locked at the pick and note the request sent until its
  // round arrives (docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md).
  function questionCard(q, { n = 0, draft = {}, links = {}, fit = () => null } = {}) {
    if (q.state === 'resolved') return resolvedCard(q, links);
    const locked = q.state === 'requested';
    const chosen = locked ? q.request.choice : choiceOf(q, draft);
    return `<section class="q ${q.urgent && q.state === 'open' ? 'urgent' : ''}" id="${esc(q.id)}" data-q="${esc(q.id)}">
      <div class="row" style="margin:0"><span class="muted small">${n ? n + '. ' : ''}${esc(q.source || '')}</span>${badge(QUESTION_STATE[q.state].tone, QUESTION_STATE[q.state].label)}</div>
      <h3>${linkText(q.question, links)}</h3>
      ${q.context ? `<div class="ctx">${linkText(q.context, links)}</div>` : ''}
      ${framed(q) ? '' : questionLink(q.url)}
      ${confirmLines(q)}
      ${inline(q) ? takes(q, chosen, links, fit, locked) : q.options.map((o) => option(o, { name: 'c-' + q.id, checked: chosen === o.id, locked, suggested: suggestedLine(q, o, links) })).join('')}
      ${locked ? (q.request.note ? `<div class="ans"><div class="muted small">You · ${esc(time(q.request.ts))}</div><div>${linkText(q.request.note, links)}</div></div>` : '') : noteComposer(q, draft.note)}
      ${answerHistory(q, links)}
    </section>`;
  }
  // A card's pill is its ID, or for an ask (item:ask:<id>) the time it appeared; other topics keep their title.
  const topicName = (t) => (t.askedAt ? BoardUI.cardTime(t.askedAt) : (String(t.title).match(/^([A-Z]+-\d+|[A-Z]\d+):/) || [])[1] || t.title);
  // /api/board's ownerTopics, each card's topic named from its card, which the board sends in its place while the card
  // is on the board (board/server.mjs pageBoard). cards: the board's items.
  function cardTopics(topics, cards) {
    const byKey = new Map(cards.map((c) => [c.key, c]));
    return topics.map((t) => {
      const c = t.title === undefined && byKey.get(t.card);
      return c ? { ...t, title: `${c.ref}: ${c.title}`, summary: 'Questions about this work item.', ...(c.kind === 'ask' ? { askedAt: c.ask.askedAt } : {}) } : t;
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

  Object.assign(globalThis.BoardUI, { choiceLabel, choiceOf, option, answerHistory, questionCard, roundChip, takes, topicName, cardTopics, topicRow, nextQuestion, sentNotice });
})();
