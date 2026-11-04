# Overnight triage suggests your earlier answers

Follows [triage runs once overnight on cards waiting on your answers](2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md), whose "Later" this is (#218).

- **What counts as confident.** Only the owner's own earlier answers on other cards and their long-running context, such as what they said in other cards' threads and notes. Not ADRs or CONTEXT.md: the grill already read those, so a question one of them answers shouldn't reach the owner at all (owner, gh218-confident). A model's own opinion is what `recommended` already says.
- **The field.** A question carries `suggested {option, card, answer}`: the option, the earlier card's ref and the owner's answer in their words. `question add` checks that the option is one of the question's own. Questions can't be edited, so the triage posts the question again with a new id and resolves the old one "Replaced by <new id>".
- **Never applied.** The session never answers or resolves a question on a suggestion (owner, gh218-auto). The night's quiet-hours hold means the owner sees it in the morning anyway, so waiting costs one tap.
- **Accepting is the topic's Send.** The suggested option is pre-checked: with no draft and no answer, a question's pick is its suggestion (`ui-questions.js` `choiceOf`), so the topic's Send counts and sends it with the other answers, and the owner can pick another first (owner, gh218-accept). While one is still pre-checked, the Send bar reads "suggested options are selected".
- **How it looks** (prototype suggested-answer, take A). A green lowercase "suggested" chip beside the option's label and, under the option, a gray line: You answered this on #N: "<answer>", the ref linked as any ref is. "Recommended" became lowercase "recommended", like the other badge words.

Considered:
- marking the suggestion with `recommended`: nearly every grill question already has one, so it would say nothing new;
- an Accept button per suggestion: a second way to answer beside Send;
- naming the earlier question by id instead of copying the card and answer: the page would need resolved questions from other topics, which `/api/board` leaves out.
