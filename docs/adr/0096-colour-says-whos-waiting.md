# Colour says who's waiting

The owner set the rule on hub/INT-226: a colour on the hub or a board says who is waiting, so the owner can tell at a glance whether something is theirs to do.

- **Blue** (`--accent`, the info status colour) means a human is needed: an unread review, what's next for the owner, a new version to reload. The owner's action buttons, badges and rows that wait on the owner are blue.
- **Orange** (`--warn`, the notice status colour) means a builder, reviewer or the machine is working or waiting, not the human at the hub. Orange is never on something the owner must do.
- **Red** (`--bad`, the danger status colour) means danger: something failed, is offline, or spends or loses something if left.
- **Grey** (`--muted`, the quiet status colour) means idle. An idle state has no other colour.
- Green (`--ok`, the success status colour) keeps its meaning from [0033](0033-one-colour-constants-file-shared-by-the-hub-and-every-board.md): done or passing.

Links, focus rings and the primary button still use `--accent`, which reads as "you can act here". This replaces 0033's "working or waiting on attention is notice": waiting on the owner is info, and working or waiting on someone else is notice. The colours themselves stay in `shared/colors.css` as 0033 decided.

INT-211's amber Paused (the machine waits), red Keep going (it spends credits) and INT-219's blue reload row (the owner acts) already follow the rule. Colours that break it, such as the orange Action needed badge and the orange button that clears it ([0045](0045-the-lane-follows-who-acts-next.md), [0053](0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md), [0067](0067-a-cards-external-links-share-the-last-details-line.md)), are listed on hub/INT-226 and change as the owner approves each; until then those ADRs describe the board as it is.

Considered:
- orange for the owner's actions, as Action needed has it. Orange already means a builder is working, so one colour said both "wait" and "act".
- a colour per actor beyond these four. The owner wants one question answered by colour, whose turn it is, and more hues would need a legend.
