# Resolved questions fold away once you leave their topic

Card #376. This corrects docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md, whose "In place until reload" now ends when you leave the topic.

- **In place while the topic shows.** view-questions.js `inPlace` holds the shown topic's questions drawn unsent. A sent one stays where it is, resolved, while you are on its topic, and a Send that leaves questions open stays on the topic.
- **Leaving folds them.** `setTopic` is the one place the shown topic changes (a pill tap, a hash link, `pick`, the pane's `openTopic`, and `moveOn` going to the next topic). The topic left drops its ids from `inPlace`, so they join its "resolved (N)" fold, and coming back to it, for a new question say, shows them already folded. The automatic move after the last answer is leaving too.
- **No topic to go on to.** In the desktop Needs you pane (no `ctx.up`), the last Send has no next topic and no board to go back to. The pane shows the moon and "no open questions", and the Sent line shows as a toast.
- **The fold says only the count.** The collapsed summary is "› resolved (N)"; the list of question names and its CSS are gone. The questions are inside the fold when it opens.
