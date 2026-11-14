// A card's thread: the orchestrator's lines (who claude, named Orchestrator), the board's status lines, its builders'
// asks, the owner's messages and their replies. Needs ui.js, ui-links.js, ui-enums.js and ui-markdown.js.
(function () {
  const { esc, escText, time, etaLine, replyBody, attachments, sendButton, thinkingLine, linkText, linkHtml, anyLink, mark, statusMark, cardRef } = globalThis.BoardUI;
  const VIA = { slack: ' · Slack', github: ' · GitHub' };
  // ui-markdown.js loads after this file, so markdown is looked up when a thread draws.
  const markdown = (src, links) => globalThis.BoardUI.markdown(src, links);
  // The orchestrator's own messages are markdown in compact styles; the owner's, a shared person's and GitHub's or
  // Slack's stay as written (docs/adr/2026-11-09-1453-orchestrator-messages-replies-and-transcript-text-are-markdown.md).
  const drawsMarkdown = (m) => m.who === 'claude' && !m.html;
  // A link to a card on this board (#selectedCard=<key>) or on another board (/<route>/#selectedCard=<key>, an ask's move), or ''.
  function cardLink(link) {
    if (!/^(?:\/[\w-]+\/)?#(?:selectedCard|item)=[^&]+/.test(link)) return '';
    return `<a href="${esc(link)}">Open the task →</a>`;
  }
  // A message's state comes from domain.mjs threadOf, or, for one the page hasn't sent yet, from app-threads.js's outbox
  // (sending or failed).
  const stateOf = (m) => m.state || (m.reply ? 'replied' : 'waiting');
  const icon = (body) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const RETRY = icon('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>');
  const DISMISS = icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
  // docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md
  // An owner's message's footer: its time, then the tap it came from (m.status, such as "answers submitted"), then where
  // it is: sending… until the board has it, waiting… until Claude picks it up, thinking… while Claude works on it
  // (docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md). A send that failed reads not sent,
  // with Retry and X (app-threads.js [data-resend], [data-unsend]). A bare tap's status line reads the same after its
  // time (docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md).
  const PICK_UP = {
    sending: () => '<span>sending…</span>',
    waiting: () => '<span>waiting…</span>',
    working: (m) => thinkingLine(m.since),
    failed: (m) => `<span class="not-sent">not sent</span><span class="send-again"><button type="button" class="ghost icon" data-resend="${esc(m.sendId)}" aria-label="Retry" title="Retry">${RETRY}</button><button type="button" class="ghost icon" data-unsend="${esc(m.sendId)}" aria-label="Dismiss" title="Dismiss, its text back in the box">${DISMISS}</button></span>`,
  };
  // Where an owner's message or a New strip row the page hasn't sent yet (ui-cards.js newEntry) is, by its state.
  const pickUp = (m) => PICK_UP[stateOf(m)]?.(m);
  // Every message's footer: its time, its own tags (via, Moved, Edited), the tap, and for the owner's own message where it is.
  const msgFooter = (m, tags) => {
    const parts = [`<span>${esc(time(m.ts))}</span>`, ...tags.map((t) => `<span>${t}</span>`), m.status && `<span class="foot-status">${statusMark(m.status)}${esc(m.status)}</span>`, footed(m) && pickUp(m)].filter(Boolean);
    return `<div class="reply muted small msg-foot">${parts.join('<span>·</span>')}</div>`;
  };
  // The owner's messages, the board's events and the outbox's, also show where they are in their footer.
  const footed = (m) => Boolean(m.eventId || m.sendId);
  // Each reply becomes Claude's own message at the time it was written, quoting the owner's message
  // when other messages came between them. A reply with no time follows its message.
  const withReplies = (msgs) => {
    // A folded submit's answers each reply, quoting their own block.
    const out = msgs.flatMap((m, i) => [{ m, at: String(m.ts), i, part: 0 },
      ...(m.answers || [m]).filter((a) => a.eventId && a.reply).flatMap((a) => (a.replies?.length ? a.replies : [a.reply]).map((reply, k) => ({ m: { ts: reply.at || m.ts, who: 'claude', kind: 'reply', reply }, of: m, quoted: m.answers ? a.text : m.text, later: k > 0, at: String(reply.at || m.ts), i, part: 1 })))]);
    out.sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i || a.part - b.part);
    return out.map(({ m, of, quoted, later }, n) => (of ? { ...m, quote: later || out[n - 1]?.m === of && !(of.answers?.length > 1) ? '' : quoted || '' } : m));
  };
  // A request or board line's one tone, by the colour rule (red fault > orange staged or asking > green readied > blue
  // created > gray); style.css colours its icon, words and link from this class alone. A questions-added line is asking
  // while its batch has an open question and gray once none has
  // (docs/adr/2026-11-13-0130-a-questions-added-line-is-stored-and-stays-in-the-thread.md).
  const tone = (m) => (m.fault ? ' fault' : m.command === 'staged' ? ' staged' : m.line === 'questions-added' ? (m.open ? ' asking' : '')
    : m.command === 'readied' ? ' readied'
    : ['created', 'created-from'].includes(m.command) || ['ticket-made', 'ask-routed', 'handed-from'].includes(m.line) ? ' created' : '');
  // Every status line's shell: its classes, its mark and words (head), then " · " and its time, with `by` before the time
  // and `after` behind it, so no kind can leave its time out
  // (docs/adr/2026-11-13-1959-every-status-line-shows-its-time-from-one-shell.md). A line with `rest` is a closed details
  // line whose summary is the shell's words and whose body is rest; `summary` is the summary's own attributes.
  const statusLine = (cls, head, ts, { by, after, rest, summary = '', sendId } = {}) => {
    const words = `${head} <span class="muted">· ${by ? `${esc(by)} · ` : ''}${esc(time(ts))}${after ? ` · ${after}` : ''}</span>`;
    return rest === undefined ? `<div class="msg status-line ${cls}"${sendId ? ` data-send="${esc(sendId)}"` : ''}>${words}</div>`
      : `<details class="msg status-line ${cls}"><summary${summary}>${words}</summary>${rest}</details>`;
  };
  const linked = (link, text) => `<a href="${esc(link)}">${text}</a>`;
  // A questions-added line's words, as written, open the card's questions sheet (app-questions-sheet.js) from its first
  // question; the link to the questions page stays under it for a page that has no sheet.
  const questionsLink = (m) => `<a href="${esc(m.link)}" data-questions="${esc(m.questions[0])}">${escText(m.text)}</a>`;
  // A line naming a card (domain.mjs namedLine): its words, then the card's reference as it stands (ui-links.js cardRef).
  const named = (m, links) => `${escText(m.words)} ${cardRef(m.card, links)}`;
  const line = (m, links) => (m.kind === 'reply'
    ? `<div class="msg claude reply-msg"><div class="who">Orchestrator</div>${m.quote ? `<blockquote class="quote">${linkText(m.quote, links)}</blockquote>` : ''}<div class="body${m.reply.md ? ' md' : ''}">${replyBody(m.reply, links)}</div>${msgFooter(m, [])}</div>`
    : m.kind === 'ask-link' ? statusLine('link', statusMark('ask-link') + named(m, links), m.ts)
    // docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md: a visual's page opens full page.
    : m.kind === 'visual' ? statusLine('link visual', statusMark('visual') + linked(m.link, `${escText(m.text)} →`), m.ts)
    // A request line's mark is its words' icon, or m.mark's for a line whose words vary; a Full person's names them.
    : m.request && m.card ? statusLine(`request${tone(m)}`, statusMark(m.mark) + named(m, links), m.ts)
    // A bare tap's line, the outbox's or its event's, carries where it is after its time, as a message's footer does; the
    // board's own lines (a Hold's, a bare Implement's) have no state, as no session picks them up.
    : m.request ? statusLine(`request${tone(m)}`, statusMark(m.mark || m.text) + escText(m.text), m.ts, { by: m.by, after: m.state && PICK_UP[m.state]?.(m), sendId: m.sendId })
    // docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md: the board's
    // own line, its kind's mark and words, red for a fault.
    : m.kind === 'hub' && m.detail ? statusLine(`request hub fault-detail${tone(m)}`, statusMark(m.mark) + escText(m.text), m.ts, { rest: `<pre class="fault-error">${esc(m.detail)}</pre>` })
    : m.kind === 'hub' ? statusLine(`request hub${tone(m)}`, statusMark(m.mark) + (m.card ? named(m, links) : m.line === 'questions-added' && m.link && m.questions?.length ? questionsLink(m) : m.link ? linked(m.link, escText(m.text)) : linkText(m.text, links)), m.ts)
    // docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md: a card's move between lanes.
    : m.kind === 'move' ? statusLine('request move', statusMark('move') + escText(m.text), m.ts)
    : m.folded ? foldedRun(m, links)
    : m.kind === 'status' ? statusLine(`builder-status${m.planner ? ' planner' : ''}`, mark('<span class="working-dot"></span>') + linkText(m.text, links), m.ts)
    // A builder's judgment calls: their posted time, then whether the session verified them and when.
    : m.kind === 'calls' ? statusLine('calls', `${statusMark('judgment calls')}${escText(m.text)}'s judgment calls · ${m.calls.length}`, m.ts, {
      after: m.verified ? `verified ${esc(time(m.verified.at))}` : 'not verified yet',
      rest: `<ol>${m.calls.map((c) => `<li>${linkText(c, links)}</li>`).join('')}</ol>${m.verified?.note ? `<div class="small">Verified: ${linkText(m.verified.note, links)}</div>` : ''}`,
    })
    : m.kind === 'agent' ? statusLine(`agent ${m.finished ? 'finished' : 'started'}${m.planner ? ' planner' : ''}`, mark('<span class="agent-dot"></span>') + escText(m.text), m.ts, { after: m.eta && esc(etaLine(m.eta)) }) : `<div class="msg ${m.who === 'love' ? 'love' : m.who === 'claude' ? 'claude' : 'other'}"${m.eventId ? ` data-event="${esc(m.eventId)}"` : m.sendId ? ` data-send="${esc(m.sendId)}"` : ''}>
        <div class="who">${m.who === 'love' ? (m.by ? esc(m.by) : 'You') : m.who === 'claude' ? 'Orchestrator' : esc(m.who)}</div>
        <div class="body${drawsMarkdown(m) ? ' md' : ''}">${m.html ? linkHtml(m.html, links) : drawsMarkdown(m) ? markdown(m.text, links) : linkText(m.text, links)}</div>${m.note ? `<blockquote class="quote">${linkText(m.note, links)}</blockquote>` : ''}${attachments(m.files)}
        ${m.log ? `<div class="small"><a href="log.html?file=${encodeURIComponent(m.log)}">View transcript</a></div>` : ''}
        ${m.link ? `<div class="small">${cardLink(m.link) || anyLink(m.link, m.link)}</div>` : ''}
        ${msgFooter(m, [VIA[m.via]?.slice(3), m.moved && 'Moved', m.edited && 'Edited'].filter(Boolean))}
      </div>`);

  // One agent run (domain.mjs threadOf gives its started line, status lines and finished line the same `run`) is one
  // closed details line at its first line's place: the action, then its status, finished when its newest line is a finished
  // line and running otherwise, then its newest line's time;
  // expanding it shows the run's lines and, when the run has a log, a View transcript link.
  function foldedRun(m, links) {
    const newest = m.folded.at(-1);
    const tail = newest.finished ? 'finished' : 'running';
    const log = m.folded.find((f) => f.log)?.log;
    const logLine = log ? `<div class="small fold-log"><a href="log.html?file=${encodeURIComponent(log)}">View transcript</a></div>` : '';
    return statusLine(`calls status-fold${m.planner ? ' planner' : ''}`, `${statusMark('status lines')}${escText(m.agent)} · ${tail}`, newest.ts, {
      summary: tail === 'finished' ? ' class="finished"' : '', rest: m.folded.map((f) => line(f, links)).join('') + logLine,
    });
  }
  function foldStatus(lines) {
    const runs = new Map();
    for (const m of lines) if (m.run && (m.kind === 'status' || m.kind === 'agent')) runs.set(m.run, [...(runs.get(m.run) || []), m]);
    return lines.flatMap((m) => {
      const run = m.run && (m.kind === 'status' || m.kind === 'agent') ? runs.get(m.run) : null;
      if (!run) return [m];
      return m === run[0] ? [{ ...m, folded: run }] : [];
    });
  }

  const STEP = 3;
  const UNREAD_CAP = 10;
  // Every kind of system line; each leads with a mark, and a test renders each, so a new kind needs an entry in ui.js MARK_ICONS.
  const SYSTEM_KINDS = ['status', 'agent', 'calls', 'ask-link', 'visual', 'command', 'move', 'hub'];
  const { isMessage } = globalThis.BoardUI;
  // Only Claude's and GitHub's messages and the board's fault lines are unread, as on the badge (domain.mjs othersAt,
  // ui-cards.js unreadCount); the orchestrator's answer to a builder's ask never is.
  const unread = (m, seenAt) => Boolean(seenAt) && (m.fault || (isMessage(m) && m.kind !== 'builder-answer' && (m.who === 'claude' || m.via === 'github'))) && String(m.ts) > seenAt;
  // The window opens from the oldest unread message, at most UNREAD_CAP messages back.
  function threadWindow(lines, { seenAt = null, more = 0, upto = null, from = null }) {
    const counted = lines.flatMap((m, i) => (isMessage(m) && (!upto || String(m.ts) <= upto) ? [i] : []));
    const firstUnread = lines.findIndex((m) => unread(m, seenAt));
    const unreadSpan = firstUnread < 0 ? 0 : counted.filter((i) => i >= firstUnread).length;
    const want = Math.max(STEP, Math.min(UNREAD_CAP, unreadSpan)) + STEP * more;
    // Once drawn, the top edge is `from` and Show more taps move it back, so a deleted message leaves a gap.
    const edge = from ? lines.findIndex((m) => String(m.ts) >= from) : -1;
    const before = counted.filter((i) => i < edge);
    const back = STEP * more;
    const top = edge < 0 ? (counted.length > want ? counted[counted.length - want] : 0) : back && before.length >= back ? before[before.length - back] : back ? 0 : edge;
    const hidden = lines.filter((m, i) => i < top && isMessage(m)).length;
    return { start: hidden ? top : 0, hidden };
  }
  // The ts of the oldest line the window draws, null when it hides none: the open card's `from`.
  function threadFrom(msgs, view) {
    const lines = foldStatus(withReplies(msgs));
    const { start } = threadWindow(lines, view);
    return start ? String(lines[start].ts) : null;
  }
  const moreButton = (hidden) => `<button type="button" class="thread-more" data-thread-more>Show more <span class="n">· ${hidden} previous message${hidden === 1 ? '' : 's'}</span></button>`;

  // links: the thread's ui-links.js linkContext. view: {seenAt, more,
  // upto}, the card's seen mark from before it opened, its Show more taps and its newest line's ts when it first drew,
  // draws the open card's window, so lines after `upto` add below without hiding older ones; null draws every line.
  function threadMessages(msgs, links = {}, view = null) {
    if (!msgs.length) return '<div class="muted small">No messages here yet.</div>';
    const lines = foldStatus(withReplies(msgs));
    const { start, hidden } = view ? threadWindow(lines, view) : { start: 0, hidden: 0 };
    const shown = lines.slice(start);
    if (start && shown[0].kind === 'reply' && !shown[0].quote) shown[0] = { ...shown[0], quote: lines[start - 1].text || '' };
    return (hidden ? moreButton(hidden) : '') + shown.map((m) => line(m, links)).join('');
  }

  // docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md
  // An In Review card's Done, the second of its thread box's pair after Reply, on ⌥↵. It confirms and sends card-done
  // (app-cards.js); the board applies it before the session follows up
  // (docs/adr/2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md).
  // Primary while a card waits only on it (docs/adr/2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md).
  const doneTone = (it) => (it.awaitsDone || it.resolvedBy === globalThis.BoardUI.BUTTON.done ? 'closes' : '');
  function doneButton(it) {
    const tone = doneTone(it);
    return sendButton('Done', 1, `${tone ? ` class="${tone}"` : ''} data-confirm="finish" data-key="${esc(it.key)}"`);
  }

  Object.assign(globalThis.BoardUI, { DISMISS, pickUp, threadMessages, threadFrom, withReplies, doneButton, doneTone, SYSTEM_KINDS });
})();
