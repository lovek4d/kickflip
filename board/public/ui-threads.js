// A card's thread: the orchestrator's lines (who claude, named Orchestrator), its builders' asks, the owner's messages and
// their replies. Needs ui.js, ui-links.js and ui-enums.js.
(function () {
  const { esc, time, etaLine, replyBody, attachments, attachButton, dropZone, editButton, withdrawButton, workingLine, linkText, linkHtml, anyLink, mark, statusMark, BUTTON } = globalThis.BoardUI;
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
  const stateOf = (m) => m.state || (m.reply ? 'replied' : 'waiting');
  // A message's footer: the tap it came from (m.status, such as "answers submitted"), then, to its right, Claude's
  // pick-up while it waits (docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md).
  const PICK_UP = { working: workingLine, waiting: 'Waiting for Claude…' };
  const msgFooter = (m) => {
    const parts = [m.status && `<span class="foot-status">${statusMark(m.status)}${esc(m.status)}</span>`, PICK_UP[stateOf(m)]].filter(Boolean);
    return parts.length ? `<div class="reply muted small">${parts.join('')}</div>` : '';
  };
  // Each reply becomes Claude's own message at the time it was written, quoting the owner's message
  // when other messages came between them. A reply with no time follows its message.
  const withReplies = (msgs) => {
    const out = msgs.flatMap((m, i) => [{ m, at: String(m.ts), i, part: 0 },
      ...(m.eventId && m.reply ? [{ m: { ts: m.reply.at || m.ts, who: 'claude', kind: 'reply', reply: m.reply }, of: m, at: String(m.reply.at || m.ts), i, part: 1 }] : [])]);
    out.sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i || a.part - b.part);
    return out.map(({ m, of }, n) => (of ? { ...m, quote: out[n - 1]?.m === of ? '' : of.text || '' } : m));
  };
  // A message being edited shows its edit box in place of its text; app-asks.js handles the form, and attach.js the
  // files it adds to the message, under composer id edit:<event id>.
  const editForm = (id, text) => `<form class="edit-form" data-edit-form="${esc(id)}" data-composer="edit:${esc(id)}">${dropZone(`<textarea rows="3">${esc(text)}</textarea>`)}
        <div class="pending-files" data-files></div>
        <div class="row">${attachButton()}<span><button type="button" data-edit-cancel>Cancel</button> <button class="primary" type="submit">Save</button></span></div></form>`;
  // batched: an answer followed by another of the owner's answers in its state, which carries the batch's footer.
  const line = (m, links, edits, batched = false) => (m.kind === 'reply'
    ? `<div class="msg claude reply-msg"><div class="who">Orchestrator · ${esc(time(m.ts))}</div>${m.quote ? `<blockquote class="quote">${linkText(m.quote, links)}</blockquote>` : ''}<div class="body">${linkHtml(replyBody(m.reply), links)}</div></div>`
    : m.kind === 'ask-link' ? `<div class="msg link"><a href="${esc(m.link)}">${esc(m.text)} →</a></div>`
    : m.request ? `<div class="msg request">${statusMark(m.text)}${esc(m.text)} <span class="muted">· ${esc(time(m.ts))}</span></div>`
    : m.kind === 'questions' ? `<div class="msg builder-status planner new-questions">${statusMark('questions')}<a href="${esc(m.link)}">${esc(m.text)}</a> <span class="muted">· ${esc(time(m.ts))}</span></div>`
    : m.kind === 'status' ? `<div class="msg builder-status${m.planner ? ' planner' : ''}">${mark('<span class="working-dot"></span>')}${linkText(m.text, links)} <span class="muted">· ${esc(time(m.ts))}</span></div>`
    : m.kind === 'calls' ? `<details class="msg calls"><summary>${esc(m.text)}'s judgment calls · ${m.calls.length} · ${m.verified ? `verified ${esc(time(m.verified.at))}` : 'not verified yet'}</summary><ol>${m.calls.map((c) => `<li>${linkText(c, links)}</li>`).join('')}</ol>${m.verified?.note ? `<div class="small">Verified: ${linkText(m.verified.note, links)}</div>` : ''}</details>`
    : m.kind === 'agent' ? `<div class="msg agent ${m.finished ? 'finished' : 'started'}${m.planner ? ' planner' : ''}">${mark('<span class="agent-dot"></span>')}${esc(m.text)} <span class="muted">· ${esc(time(m.ts))}${m.eta ? ` · ${esc(etaLine(m.eta))}` : ''}</span></div>` : `<div class="msg ${m.who === 'love' ? 'love' : m.who === 'claude' ? 'claude' : 'other'}"${m.eventId ? ` data-event="${esc(m.eventId)}"` : ''}>
        ${m.canDelete || m.canEdit ? `<div class="ask-actions">${m.canEdit ? editButton(m.eventId) : ''}${m.canDelete ? withdrawButton(m.eventId) : ''}</div>` : ''}
        <div class="who">${m.who === 'love' ? 'You' : m.who === 'claude' ? 'Orchestrator' : esc(m.who)}${VIA[m.via] || ''}${m.moved ? ' · Moved' : ''}${m.from ? ` · Moved from ${esc(m.from)}` : ''}${m.edited ? ' · Edited' : ''} · ${esc(time(m.ts))}</div>
        <div class="body"${edits.has(m.eventId) ? ' hidden' : ''}>${m.html ? linkHtml(m.html, links) : linkText(m.text, links)}</div>${edits.has(m.eventId) ? editForm(m.eventId, edits.get(m.eventId).text) : ''}${attachments(m.files)}
        ${m.log ? `<div class="small"><a href="log.html?file=${encodeURIComponent(m.log)}">Open the log →</a></div>` : ''}
        ${m.link ? `<div class="small">${cardLink(m.link) || anyLink(m.link, m.link)}</div>` : ''}
        ${m.eventId && !batched ? msgFooter(m) : ''}
      </div>`);

  const STEP = 3;
  const UNREAD_CAP = 10;
  const NOT_MESSAGE = new Set(['status', 'agent', 'calls', 'ask-link', 'questions']);
  const isMessage = (m) => !NOT_MESSAGE.has(m.kind);
  // Only Claude's and GitHub's messages are unread, as on the badge (domain.mjs othersAt, ui-cards.js unreadCount); the
  // orchestrator's answer to a builder's ask never is.
  const unread = (m, seenAt) => Boolean(seenAt) && isMessage(m) && m.kind !== 'builder-answer' && (m.who === 'claude' || m.via === 'github') && String(m.ts) > seenAt;
  const batchedAt = (lines, i) => {
    const next = lines.slice(i + 1).find(isMessage);
    return lines[i].kind === 'owner-answer' && next?.kind === 'owner-answer' && stateOf(next) === stateOf(lines[i]);
  };
  // The window opens from the oldest unread message, at most UNREAD_CAP messages back; a message being edited always shows.
  function threadWindow(lines, { seenAt = null, more = 0, upto = null }, edits) {
    const counted = lines.flatMap((m, i) => (isMessage(m) && (!upto || String(m.ts) <= upto) ? [i] : []));
    const firstUnread = lines.findIndex((m) => unread(m, seenAt));
    const unreadSpan = firstUnread < 0 ? 0 : counted.filter((i) => i >= firstUnread).length;
    const want = Math.max(STEP, Math.min(UNREAD_CAP, unreadSpan)) + STEP * more;
    const pinned = lines.findIndex((m) => m.eventId && edits.has(m.eventId));
    const start = Math.min(counted.length > want ? counted[counted.length - want] : 0, pinned < 0 ? Infinity : pinned);
    const hidden = lines.filter((m, i) => i < start && isMessage(m)).length;
    return { start: hidden ? start : 0, hidden };
  }
  const moreButton = (hidden) => `<button type="button" class="thread-more" data-thread-more>Show more <span class="n">· ${hidden} previous message${hidden === 1 ? '' : 's'}</span></button>`;

  // links: the thread's ui-links.js linkContext. edits: the open edit boxes by event id, {text}. view: {seenAt, more,
  // upto}, the card's seen mark from before it opened, its Show more taps and its newest line's ts when it first drew,
  // draws the open card's window, so lines after `upto` add below without hiding older ones; null draws every line.
  function threadMessages(msgs, links = {}, edits = new Map(), view = null) {
    if (!msgs.length) return '<div class="muted small">No messages here yet.</div>';
    const lines = withReplies(msgs);
    const { start, hidden } = view ? threadWindow(lines, view, edits) : { start: 0, hidden: 0 };
    const shown = lines.slice(start);
    if (start && shown[0].kind === 'reply' && !shown[0].quote) shown[0] = { ...shown[0], quote: lines[start - 1].text || '' };
    return (hidden ? moreButton(hidden) : '') + shown.map((m, i) => line(m, links, edits, batchedAt(lines, start + i))).join('');
  }

  // The reply form's Done sends ask-done or card-done; the board applies it before the session follows up.
  // docs/adr/2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md
  // Orange while it clears an ask's Action needed, primary while a reopened card waits only on it
  // (docs/adr/2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md).
  function doneButton(it) {
    if (!it?.finishable) return '';
    const tone = it.resolvedBy === BUTTON.markDone ? 'resolves' : it.awaitsDone ? 'closes' : '';
    return `<button type="button"${tone ? ` class="${tone}"` : ''} data-confirm="finish" data-key="${esc(it.key)}">Done</button>`;
  }

  // docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
  // A card's open questions asked since seenAt as one blue line in its thread, at the newest one's time, linking to the
  // first: it.questions from the board. → [line], or [] with none new or no seen mark.
  function newQuestionsLine(questions, seenAt) {
    const fresh = seenAt ? (questions?.askedAt || []).filter((t) => String(t) > seenAt) : [];
    if (!fresh.length) return [];
    return [{ ts: fresh.at(-1), who: 'claude', kind: 'questions', text: `${fresh.length} new question${fresh.length === 1 ? '' : 's'}`, link: `questions.html#${encodeURIComponent(questions.first)}` }];
  }

  Object.assign(globalThis.BoardUI, { threadMessages, withReplies, doneButton, newQuestionsLine });
})();
