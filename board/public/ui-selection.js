// The board's one open selection, as a pure step: the card the lanes open and the topic the pane shows, which every way
// to pick one resolves to the same pair (docs/adr/2026-11-14-2359-one-owner-of-the-open-selection.md). Needs nothing else.
(function () {
  // The card a topic belongs to: item:<key> is a card's topic, any other topic belongs to none.
  const cardOf = (t) => t.card ?? (t.id.startsWith('item:') ? t.id.slice(5) : null);

  // The topic a card's open questions are in, if it has any.
  function openTopicOf(topics, card) {
    return topics.find((t) => cardOf(t) === card && t.state !== 'resolved' && t.open > 0) || null;
  }

  // nextSelection({board, event, generation}) → what the pick sets, where each side goes, and the next generation.
  // event is {question: id|null}, {topic: id|null} or {card: key}: a question or topic id that has gone, or null, opens
  // the topic the pane would open on its own (paneTopic null).
  // card: the card the board opens and scrolls to, null for none (a topic of no card, or a card event for no topic).
  // topic: the pane's topic id, null for the pane's own pick, undefined for a pick that leaves it as it is.
  // changes: the fragment's keys, both written in one write.
  function nextSelection({ board, event, generation }) {
    const topics = board?.ownerTopics || [];
    let found = null;
    let topic;
    if ('card' in event) {
      found = openTopicOf(topics, event.card);
      topic = found ? found.id : undefined;
      return { card: event.card, topic, changes: { selectedCard: event.card, ...(found ? { openItemsCard: found.id } : {}) }, generation: generation + 1 };
    }
    const id = 'question' in event ? event.question : event.topic;
    found = topicNamed(topics, id);
    topic = found?.id ?? id ?? null;
    const card = found ? cardOf(found) : null;
    return { card, topic, changes: { ...(card ? { selectedCard: card } : {}), openItemsCard: topic }, generation: generation + 1 };
  }

  // The topic a question or topic id names, if the board has it.
  const topicNamed = (topics, id) => topics.find((t) => t.id === id || t.questions?.includes(id)) || null;

  // The card a question or topic id belongs to, by its topic, else null: a topic of no card, or an id the board doesn't have.
  function cardOfQuestion(board, id) {
    const t = topicNamed(board?.ownerTopics || [], id);
    return t ? cardOf(t) : null;
  }

  // The phone's Waiting on you link for a selected card: its topic when it has open questions, else the page as it opens.
  function questionsHref(board, card) {
    const t = card && openTopicOf(board?.ownerTopics || [], card);
    return t ? `questions.html#${encodeURIComponent(t.id)}` : 'questions.html';
  }

  Object.assign(globalThis.BoardUI ||= {}, { nextSelection, cardOfQuestion, questionsHref });
})();
