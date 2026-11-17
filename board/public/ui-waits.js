// What waits on the orchestrator, as the board header draws it
// (docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md): the sheet's rows from
// /api/board's orchestratorWaits (waitsRows), an hourglass badged with their count, always drawn, and the sheet's list of them. The count
// and each row take their colour from the tone the server sends on each wait (domain.mjs waitTone; AGENTS.md's colour
// priority). Needs ui.js, ui-progress-bar.js and ui-icon-text.js.
(function () {
  // Each wait kind (domain.mjs orchestratorWaitsOf and the waits beside it) in plain words, as the step the orchestrator owes.
  const WAIT_WORDS = Object.freeze({
    intake: 'sort the new task', screen: "screen the grill's questions", ask: 'answer the ask', staging: 'look over the staged task',
    answer: "act on the owner's answer", investigate: 'investigate the task', reply: "act on the owner's reply", brief: 'write the planner brief',
    stale: 'find out why it stalled', calls: "verify the builder's calls", checking: 'land the checked build', grill: 'start the grill',
    prototype: 'draw the prototype', unasked: "post the planner's question", visual: "place the visual's page",
    refused: 'sort out the refused build', unowned: 'set what happens next', unblocked: 'act on the ended block', script: 'read the script result', triage: 'run the overnight triage',
    'pr-review': 'review the pull request', 'review-failed': "sort out the held review's failed answer", 'arch-review': 'run the architecture review',
    'slack-question': 'answer the Slack message', limbo: 'ask Implement, ask questions or close it',
  });
  // docs/adr/2026-11-16-0856-the-waits-sheet-lists-one-row-per-card-for-what-the-orchestrator-owes-now.md
  // The sheet's rows from orchestratorWaits, in its order: one per card, for the card's oldest wait the orchestrator owes
  // now, with more, the count of its others. A checked build's land is the lander's, so it is no row; an investigate is
  // the backlog, so it is the card's row only while nothing else waits on it. A wait with no card is keyed by its event,
  // so each is its own row. → [{...wait, more}]
  function waitsRows(waits) {
    const byCard = new Map();
    for (const w of waits) if (w.kind !== 'checking') byCard.set(w.key, [...(byCard.get(w.key) || []), w]);
    return [...byCard.values()].map((own) => {
      const owed = own.length > 1 ? own.filter((w) => w.kind !== 'investigate') : own;
      const oldest = owed.reduce((a, b) => (b.since < a.since ? b : a));
      return { ...oldest, more: owed.length - 1 };
    });
  }
  const TONES = ['red', 'orange', 'grey'];
  const waitsTone = (rows) => TONES.find((t) => rows.some((w) => w.tone === t)) || 'grey';
  const waitsTitle = (count) => `Waiting on the orchestrator · ${count}`;
  const HOURGLASS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/>'
    + '<path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>';
  // The hourglass beside the ?, always drawn; its badge is the row count in the strongest tone, none at 0.
  function waitsChip(rows) {
    const n = rows.length;
    return `<button type="button" class="ghost icon pages-switch waits-chip" data-waits aria-haspopup="dialog" aria-label="${n ? `${n} waiting on the orchestrator` : 'Nothing waiting on the orchestrator'}" title="Waiting on the orchestrator">`
      + `${HOURGLASS}${n ? `<span class="q-badge tone-${waitsTone(rows)}">${n}</span>` : ''}</button>`;
  }
  // rows from waitsRows; items is the board's cards: a row on one of them opens it; a row with no card (an overnight
  // triage, another board's question) names its event and opens nothing. The step and its duration take the row's tone.
  function waitsList(rows, items, now = Date.now()) {
    const { esc, liveFor } = BoardUI;
    const cards = new Set(items.map((i) => i.key));
    return `<ul class="waits-list">${rows.map((w) => {
      const step = [WAIT_WORDS[w.kind], liveFor(w.since, now)].filter(Boolean).join(' ');
      const inner = `<span class="waits-ref">${esc(w.ref)}</span><span class="waits-main"><span class="waits-title">${esc(w.title)}</span>`
        + `<span class="waits-sub"><span class="waits-step it-${w.tone}">${esc(step)}</span>${w.more ? `<span>+${w.more} more</span>` : ''}</span></span>`;
      return `<li class="waits-row">${cards.has(w.key) ? `<button type="button" class="waits-open" data-wait-open="${esc(w.key)}">${inner}</button>` : `<div class="waits-open">${inner}</div>`}</li>`;
    }).join('')}</ul>`;
  }
  Object.assign(globalThis.BoardUI ||= {}, { WAIT_WORDS, waitsRows, waitsTone, waitsChip, waitsList, waitsTitle });
})();
