# A resumed builder posts "Builder resumed" only after something else

A builder resumed to land used to post "Builder resumed to land, session <id>" between the lander's own Landing lines, repeating what they say.

The line now reads "Builder resumed", with no session id (that stays in the lander log and landers.json). `appendBuilderResumed` (board/store.mjs) posts it only when a plain thread message or an owner event on the card is newer than the newest status or hub line, the builder's section. Straight after the builder, or after an earlier "Builder resumed", the resume posts nothing and its Landing lines continue under the builder.
