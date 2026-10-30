// A card's button names, which board/domain.mjs sets as its actionButton and resolvedBy, and the kinds of its owner
// action. Each value is its name, since cards carry it in the board's JSON. Needs nothing else: board/domain.mjs runs
// this file in a vm context (docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md).
(function () {
  const BUTTON = Object.freeze({ grill: 'grill', openQuestions: 'openQuestions', markDone: 'markDone', github: 'github', merge: 'merge' });
  const ACTION_KIND = Object.freeze({ pick: 'pick', questions: 'questions', ready: 'ready', steps: 'steps', merge: 'merge', done: 'done' });
  Object.assign(globalThis.BoardUI ||= {}, { BUTTON, ACTION_KIND });
})();
