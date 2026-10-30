// A card's thread: Claude's lines, the owner's messages and their replies. Needs ui.js and ui-links.js.
(function () {
  const { esc, time, etaLine, replyBody, attachments, editButton, withdrawButton, workingLine, linkText, linkHtml, anyLink } = globalThis.BoardUI;
  const VIA = { slack: ' · Slack', github: ' · GitHub' };
  // A link to a card on this board (#item=<key>) or on another board (/<route>/#item=<key>, an ask's move), or ''.
  function cardLink(link) {
    const key = /^(?:\/[\w-]+\/)?#item=([^&]+)/.exec(link)?.[1];
    if (!key) return '';
    let ask = key.startsWith('ask:');
    try { ask = decodeURIComponent(key).startsWith('ask:'); } catch {}
    return `<a href="${esc(link)}">Open the ${ask ? 'task' : 'card'} →</a>`;
  }
  // A message's state comes from domain.mjs threadOf.
  const msgFooter = (m) => ({
    working: () => `<div class="reply muted small">${workingLine}</div>`,
    waiting: () => '<div class="reply muted small">Waiting for Claude…</div>',
  }[m.state || (m.reply ? 'replied' : 'waiting')] || (() => ''))();
  // Each reply becomes Claude's own message at the time it was written, quoting the owner's message
  // when other messages came between them. A reply with no time follows its message.
  const withReplies = (msgs) => {
    const out = msgs.flatMap((m, i) => [{ m, at: String(m.ts), i, part: 0 },
      ...(m.eventId && m.reply ? [{ m: { ts: m.reply.at || m.ts, who: 'claude', kind: 'reply', reply: m.reply }, of: m, at: String(m.reply.at || m.ts), i, part: 1 }] : [])]);
    out.sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i || a.part - b.part);
    return out.map(({ m, of }, n) => (of ? { ...m, quote: out[n - 1]?.m === of ? '' : of.text || '' } : m));
  };
  // links: the thread's ui-links.js linkContext.
  const threadMessages = (msgs, links = {}) => (msgs.length ? withReplies(msgs).map((m) => (m.kind === 'reply'
    ? `<div class="msg claude reply-msg"><div class="who">Claude · ${esc(time(m.ts))}</div>${m.quote ? `<blockquote class="quote">${linkText(m.quote, links)}</blockquote>` : ''}<div class="body">${linkHtml(replyBody(m.reply), links)}</div></div>`
    : m.kind === 'ask-link' ? `<div class="msg link"><a href="${esc(m.link)}">${esc(m.text)} →</a></div>`
    : m.kind === 'status' ? `<div class="msg builder-status"><span class="working-dot" aria-hidden="true"></span>${linkText(m.text, links)} <span class="muted">· ${esc(time(m.ts))}</span></div>`
    : m.kind === 'agent' ? `<div class="msg agent ${m.finished ? 'finished' : 'started'}"><span class="agent-dot" aria-hidden="true"></span>${esc(m.text)} <span class="muted">· ${esc(time(m.ts))}${m.eta ? ` · ${esc(etaLine(m.eta))}` : ''}</span></div>` : `<div class="msg ${m.who === 'love' ? 'love' : m.who === 'claude' ? 'claude' : 'other'}"${m.eventId ? ` data-event="${esc(m.eventId)}"` : ''}>
        ${m.canDelete || m.canEdit ? `<div class="ask-actions">${m.canEdit ? editButton(m.eventId) : ''}${m.canDelete ? withdrawButton(m.eventId) : ''}</div>` : ''}
        <div class="who">${m.who === 'love' ? 'You' : m.who === 'claude' ? 'Claude' : esc(m.who)}${VIA[m.via] || ''}${m.moved ? ' · Moved' : ''}${m.from ? ` · Moved from ${esc(m.from)}` : ''}${m.edited ? ' · Edited' : ''} · ${esc(time(m.ts))}</div>
        <div class="body">${m.html ? linkHtml(m.html, links) : linkText(m.text, links)}</div>${attachments(m.files)}
        ${m.link ? `<div class="small">${cardLink(m.link) || anyLink(m.link, m.link)}</div>` : ''}
        ${m.eventId ? msgFooter(m) : ''}
      </div>`)).join('') : '<div class="muted small">No messages here yet.</div>');

  // The reply form's Done, just left of Send, on every card not in Done: an ask's sends ask-done, a work card's or
  // follow-up's card-done, which reads "Closing…" until the session sets its status
  // (docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md).
  function doneButton(it, sending = false) {
    if (!it?.finishable) return '';
    const closing = it.kind !== 'ask' && (sending || it.closing);
    return `<button type="button" data-confirm="finish" data-key="${esc(it.key)}"${closing ? ' disabled' : ''}>${closing ? 'Closing…' : 'Done'}</button>`;
  }

  Object.assign(globalThis.BoardUI, { threadMessages, withReplies, doneButton });
})();
