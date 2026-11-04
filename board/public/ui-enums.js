// A card's button names, which board/domain.mjs sets as its actionButton and resolvedBy, the kinds of its owner
// action, the builder kinds the page reads, and the state of a card's PR, which domain.mjs sets as pr.status and its PR
// badge shows (docs/adr/0181-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md). Each value is its name,
// since cards carry it in the board's JSON. Needs nothing else: board/domain.mjs runs this file in a vm context (docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md).
(function () {
  const BUTTON = Object.freeze({ grill: 'grill', openQuestions: 'openQuestions', markDone: 'markDone', github: 'github', merge: 'merge' });
  const ACTION_KIND = Object.freeze({ pick: 'pick', questions: 'questions', ready: 'ready', steps: 'steps', merge: 'merge', done: 'done' });
  const BUILDER_KIND = Object.freeze({ install: 'install' });
  const PR_STATE = Object.freeze({ open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' });
  Object.assign(globalThis.BoardUI ||= {}, { BUTTON, ACTION_KIND, BUILDER_KIND, PR_STATE });
})();
