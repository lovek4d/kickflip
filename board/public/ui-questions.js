// Owner questions, for Waiting on you (view-questions.js). Needs ui.js and ui-links.js.
(function () {
  const { esc, time, replyBody, attachments, attachButton, linkText, linkHtml, badge, opensHere } = globalThis.BoardUI;
  // A short id such as A or C2 leads the label; a word id such as "inline" would repeat it. prototype-switcher.js answerLabel matches.
  const lead = (o) => (/^[A-Z][0-9]?$/i.test(o.id) ? `${o.id}. ` : '');
  const choiceLabel = (q, id) => { const o = q.options.find((x) => x.id === id); return o ? `${q.multi ? '' : lead(o)}${o.label}` : id || ''; };
  const option = (o, { type = 'radio', name, checked = false, numbered = true, shown = false }) => `<label class="opt"${shown ? ' aria-current="true"' : ''}><input type="${type}" name="${esc(name)}" value="${esc(o.id)}" ${checked ? 'checked' : ''}>
        <span><span class="lbl">${numbered ? esc(lead(o)) : ''}${esc(o.label)}</span>${o.recommended ? '<span class="rec">Recommended</span>' : ''}<div class="det">${esc(o.detail || '')}</div></span></label>`;

  const noteComposer = (id, note) => `<div class="composer" data-composer="${esc(id)}"><textarea class="note" rows="2" placeholder="Note (optional)">${esc(note || '')}</textarea>
      <div class="note-tools"><div class="pending-files" data-files></div>${attachButton()}</div></div>`;

  const QUESTION_STATE = {
    open: { label: 'open', tone: 'normal' },
    answered: { label: 'waiting for claude', tone: 'notice' },
    replied: { label: 'claude replied', tone: 'ready' },
    resolved: { label: 'resolved', tone: 'quiet' },
  };
  function answerHistory(q, links = {}) {
    if (!q.answers.length) return '';
    const body = q.answers.map((a) => `<div class="ans"><div class="muted small">You · ${esc(time(a.ts))}</div>${esc(choiceLabel(q, a.choice))}${a.note ? `<div>${linkText(a.note, links)}</div>` : ''}${attachments(a.files)}</div>
      ${a.reply ? `<div class="rep"><div class="muted small">Claude</div>${linkHtml(replyBody(a.reply), links)}</div>` : '<div class="muted small" style="margin-top:4px">Waiting for Claude…</div>'}`).join('');
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
    : `<div class="small" style="margin-bottom:8px"><a href="${esc(url)}"${opensHere(url) ? '' : ' target="_blank" rel="noopener"'}>${esc(url.replace(/^https:\/\/(linear\.app\/acme\/issue|github\.com)\//, ''))} ↗</a></div>`;

  // A question's takes show inline (docs/adr/0048-a-questions-takes-show-inline.md): an option with `diagram` draws
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
    && q.options.some((o) => fit(o.id)?.scrolls);
  // Grid heights decide the layout; fullH measures the chosen take at the full content width.
  function takeBody(q, o, links, fit, full = false) {
    if (o.diagram) return diagram(o.diagram) + practice(o.practice || [], links);
    if (!isPrototype(q.url)) return '';
    const size = fit(o.id);
    const h = full ? size?.fullH : size?.h;
    // Every take loads so one outside the viewport can still decide the question's layout.
    return `<div class="take-shot${h ? '' : ' measuring'}"${h ? ` style="height:${Math.round(h)}px"` : ''}><iframe src="${esc(withParam(q.url, 'take', o.id))}" title="${esc(o.label)}"></iframe></div>`;
  }
  function takes(q, chosen, links, fit) {
    const name = 'c-' + q.id;
    if (fullTakes(q, fit)) {
      const shown = q.options.find((o) => o.id === chosen) || q.options.find((o) => o.recommended) || q.options[0];
      return `<div class="takes takes-full"><div class="take-choices" role="group" aria-label="Takes">${q.options.map((o) => option(o, { name, checked: chosen === o.id, shown: o === shown })).join('')}</div><article class="take" data-opt="${esc(shown.id)}">${takeBody(q, shown, links, fit, true)}</article></div>`;
    }
    return `<div class="takes">${q.options.map((o) => `<article class="take" data-opt="${esc(o.id)}">${option(o, { name, checked: chosen === o.id })}${takeBody(q, o, links, fit)}</article>`).join('')}</div>`;
  }
  // An owner question from /api/board; draft is this device's unsent {choice, note}; links its ui-links.js linkContext;
  // fit(option id) supplies the measured grid and full-width heights.
  function questionCard(q, { n = 0, draft = {}, links = {}, fit = () => null } = {}) {
    const last = q.answers[q.answers.length - 1];
    const chosen = draft.choice ?? (last ? last.choice : null);
    const st = QUESTION_STATE[q.state];
    return `<section class="q ${q.urgent && q.state === 'open' ? 'urgent' : ''}" id="${esc(q.id)}" data-q="${esc(q.id)}">
      <div class="row" style="margin:0"><span class="muted small">${n ? n + '. ' : ''}${esc(q.source || '')}</span>${badge(st.tone, esc(st.label))}</div>
      <h3>${linkText(q.question, links)}</h3>
      ${q.context ? `<div class="ctx">${linkText(q.context, links)}</div>` : ''}
      ${framed(q) ? '' : questionLink(q.url)}
      ${q.state === 'resolved' && q.resolved ? `<div class="small muted" style="margin-bottom:8px">Resolved: ${esc(q.resolved)} A new answer reopens it.</div>` : ''}
      ${inline(q) ? takes(q, chosen, links, fit) : q.options.map((o) => option(o, { name: 'c-' + q.id, checked: chosen === o.id })).join('')}
      ${noteComposer('q:' + q.id, draft.note)}
      ${answerHistory(q, links)}
    </section>`;
  }
  const topicName = (t) => (String(t.title).match(/^([A-Z]+-\d+|[A-Z]\d+):/) || [])[1] || t.title;
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

  Object.assign(globalThis.BoardUI, { choiceLabel, option, answerHistory, questionCard, takes, topicName, topicRow, nextQuestion, sentNotice });
})();
