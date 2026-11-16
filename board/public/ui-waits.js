// What waits on the orchestrator, as the board header draws it
// (docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md): a chip counting /api/board's
// orchestratorWaits, gone at 0, and the sheet's list of them in the waits file's order. The count and each row take
// their colour from the tone the server sends on each wait (domain.mjs waitTone; AGENTS.md's colour priority). Needs ui.js, ui-progress-bar.js and
// ui-icon-text.js.
(function () {
  // Each wait kind (domain.mjs orchestratorWaitOf and the waits beside it) in plain words, as what the orchestrator owes.
  const WAIT_WORDS = Object.freeze({
    intake: 'sort the new task', screen: "screen the grill's questions", ask: 'answer the ask', staging: 'look over the staged task',
    answer: "act on the owner's answer", investigate: 'investigate the task', reply: "act on the owner's reply", brief: 'write the planner brief',
    stale: 'find out why it stalled', calls: "verify the builder's calls", checking: 'land the checked build', grill: 'start the grill',
    prototype: 'draw the prototype', unasked: "post the planner's question", visual: "place the visual's page", recheck: 'recheck the ready card',
    refused: 'sort out the refused build', unowned: 'set what happens next', unblocked: 'act on the ended block', triage: 'run the overnight triage',
    'pr-review': 'review the pull request', 'review-answer': "act on the held review's answer", 'arch-review': 'run the architecture review',
    'slack-question': 'answer the Slack message', limbo: 'ask Implement, ask questions or close it',
  });
  const TONES = ['red', 'orange', 'grey'];
  const waitsTone = (waits) => TONES.find((t) => waits.some((w) => w.tone === t)) || 'grey';
  const waitsTitle = (count) => `Waiting on the orchestrator · ${count}`;
  function waitsChip(waits) {
    if (!waits.length) return '';
    const n = waits.length;
    return `<button type="button" class="waits-chip" data-waits aria-haspopup="dialog" aria-label="${n} waiting on the orchestrator">`
      + `${BoardUI.iconText('dot', waitsTone(waits), '')}${n} waiting</button>`;
  }
  // items is the board's cards: a wait on one of them opens it; a wait with no card (an overnight triage, another
  // board's question) names its event and opens nothing.
  function waitsList(waits, items, now = Date.now()) {
    const { esc, iconText, liveFor } = BoardUI;
    const cards = new Set(items.map((i) => i.key));
    return `<ul class="waits-list">${waits.map((w) => {
      const inner = `<span class="waits-ref">${esc(w.ref)}</span><span class="waits-main"><span class="waits-title">${esc(w.title)}</span>`
        + `<span class="waits-sub"><span>${esc(WAIT_WORDS[w.kind])}</span>${iconText('dot', w.tone, liveFor(w.since, now))}</span></span>`;
      return `<li class="waits-row">${cards.has(w.key) ? `<button type="button" class="waits-open" data-wait-open="${esc(w.key)}">${inner}</button>` : `<div class="waits-open">${inner}</div>`}</li>`;
    }).join('')}</ul>`;
  }
  Object.assign(globalThis.BoardUI ||= {}, { WAIT_WORDS, waitsTone, waitsChip, waitsList, waitsTitle });
})();
