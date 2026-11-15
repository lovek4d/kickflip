# An answered question folds on Send

An answered question stayed open until the orchestrator ran `question resolve`, so a question the owner had answered
kept showing unresolved, and its answer wait kept waking the session, unless the orchestrator remembered the step.

Send now resolves each answered question of a card, noting "Answered" with the answer kept on it
(`resolveSentAnswers`), so it folds at once in the page and the thread. Prototype questions that pick no take and gate
questions keep their own resolution.

The answer wait on the orchestrator stays, since it still has to act on the answer. It ends the way a message wait
does: at the session's next thread line on the card (or a builder start, which writes one). Its Next no longer names
`question resolve`. `question resolve` stays for questions the orchestrator settles itself, and with `--close` or
`--implement` still marks the card waiting on a question Send resolved.

`moveOnAnswered` still reads "nothing open", which now holds from Send.
