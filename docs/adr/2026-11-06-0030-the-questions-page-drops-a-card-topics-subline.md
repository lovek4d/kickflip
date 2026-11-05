# The Questions page drops a card topic's subline

A card's topic header on the Questions page read "REF: Title · Questions about this work item.", the second half repeating what the pill already says. The board's card topics (`domain.mjs` ownerTopics, and `cardTopics` in `ui-questions.js`) now carry no summary, so the header shows the title alone.

Wave and lineup topics keep "Wave triage.": it names the kind of topic, which their pill (the wave's own name) doesn't.
