# The request words show only while a card is in New or Todo

- **The words are for planning a card.** What's left?, Prototype, Grill and Visual ask the orchestrator to plan, so a card's reply row and its questions show them only in New or Todo. In In Progress, In Review and Done the row keeps attach and send. The New task box is unchanged.
- **Hidden at paint time, by lane.** A thread's reply form is built once and a card moves lanes without a rebuild, so `syncSends` (`board/public/app-threads.js`) sets `data-request-words` on the thread from the card's lane on every board load, and `style.css` hides `.request-row` under `hidden`. The questions sheet sets the same attribute on its body.
- **Disabled with Implement.** While Implement is disabled (the card is staged or ready in Todo), `syncSends` disables the row's buttons too, so a key press skips them; a card that owes Implement again enables them.
