// A card's button names, which board/domain.mjs sets as its actionButton and resolvedBy, the kinds of its owner
// action, the builder kinds the page reads, and the state of a card's PR, which domain.mjs sets as pr.status and its PR
// badge shows (docs/adr/2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md). Each value is its name,
// since cards carry it in the board's JSON. Needs nothing else: board/domain.mjs runs this file in a vm context (docs/adr/2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md).
(function () {
  const BUTTON = Object.freeze({ openQuestions: 'openQuestions', github: 'github', merge: 'merge', reply: 'reply', implement: 'implement' });
  const ACTION_KIND = Object.freeze({ pick: 'pick', questions: 'questions', ready: 'ready', steps: 'steps', merge: 'merge', stalled: 'stalled', implement: 'implement' });
  const BUILDER_KIND = Object.freeze({ install: 'install' });
  const PR_STATE = Object.freeze({ open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' });
  // Each lane's phases, in order, which a card stores beside its lane (docs/adr/2026-11-11-1200-every-lane-has-phases.md).
  // In Progress's are the five build steps its progress bar draws; a review's "reviewers" and "merge" read "pending review"
  // and "pending merge" on the card (ui-cards.js PHASE_LOOK).
  const PHASES = Object.freeze({
    todo: Object.freeze(['new', 'discussing', 'grilling', 'prototyping', 'staging', 'ready']),
    progress: Object.freeze(['reading', 'building', 'testing', 'checking', 'landing']),
    review: Object.freeze(['draft', 'reviewers', 'merge', 'stale']),
    done: Object.freeze(['merged', 'closed']),
  });
  Object.assign(globalThis.BoardUI ||= {}, { BUTTON, ACTION_KIND, BUILDER_KIND, PR_STATE, PHASES });
})();
