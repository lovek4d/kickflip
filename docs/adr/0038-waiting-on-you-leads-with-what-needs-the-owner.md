# Waiting on you leads with what needs the owner

The top row of Waiting on you (`questions.html`) shows only the topics with a question the owner hasn't answered. Topics that wait only on Claude move to a fold at the bottom.

- **The top row** has one pill per unresolved topic with at least one open question. A pill is named by the card id its title starts with ("INT-92", "B5"); any other topic keeps its whole title. Its count is the topic's open questions. The row hides when fewer than two pills would show.
- **The current topic keeps its pill** even when it no longer needs the owner, such as one opened from Waiting on Claude, so the row doesn't jump under them. A Send that leaves the topic with nothing open moves on instead: to the topic whose pill was to its left, else to its right, else any other topic with an open question, else back to the board, saying what it sent. A Send that leaves a question open stays.
- **The line under the row** shows the current topic's full title, then its summary when it has one.
- **Waiting on Claude · N** folds below the Send bar, above Resolved topics, in the same look. It lists the unresolved topics with no open question, each opening its topic, with a muted state word: "answered" when any of its questions waits for Claude's reply, else "Claude replied".
- **The page opens** on the urgent question alone when there is one, else on the first topic with an open question, as before.

`board/public/ui-questions.js` holds the pure pieces: `topicName` names a pill, `topicRow` splits the topics into the pills and the fold, and `BoardUI.nextQuestion(owner, topics, answered)` owns moving on for both Send and a prototype pick ([0048](0048-a-questions-takes-show-inline.md)). It takes the owner questions in owner.json order, the topics in pill order before the answer, and the question or topic just answered. It returns the next open question on that topic, after the answered question and wrapping to the top, else the first open question on the nearest topic to the left, else to the right, else any open question; with none it returns null for the board. A topic-wide Send omits the question id and stays while that topic has an open question. Answering an urgent question shown alone follows the same rule for its topic; another urgent question does not override that order. The callers open the returned question in their own view. `board/ui.test.mjs` owns the rule cases; the two views’ tests check that they follow its result.

The owner picked take A, "Only what needs you", from a prototype on the `ios-orchestrator` site. Every unresolved topic had a pill with its full title, so cards whose questions were all answered crowded out the two that needed the owner.

Considered:
- B, one picker naming the current topic, opening a list split into Needs you and Waiting on Claude. It hides what needs the owner behind a tap.
- C, a topic list with full titles and counts, like the hub. It pushes the questions below the fold on a phone.
