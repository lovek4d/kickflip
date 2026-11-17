// The card a question link opens (app-pane.js focusQuestion), as a pure step. Needs nothing else.
(function () {
  // The card a topic belongs to: item:<key> is a card's topic, any other topic belongs to none.
  const cardOf = (t) => t.card ?? (t.id.startsWith('item:') ? t.id.slice(5) : null);

  // The card a question or topic id belongs to, by its topic, else null: a topic of no card, or an id the board doesn't have.
  function cardOfQuestion(board, id) {
    const t = (board?.ownerTopics || []).find((x) => x.id === id || x.questions?.includes(id));
    return t ? cardOf(t) : null;
  }

  Object.assign(globalThis.BoardUI ||= {}, { cardOfQuestion });
})();
