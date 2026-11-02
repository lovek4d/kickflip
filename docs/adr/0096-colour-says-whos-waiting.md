# Colour says who's waiting

The owner set the rule on hub/INT-226: a colour on the hub or a board says whether something waits for attention, is there for the owner to read or see, is in danger, or is idle.

- **Blue** (`--accent`, the info status colour) is only for review and notice: something for the human to read or see, such as an unread review or a new version to reload.
- **Orange** (`--warn`, the notice status colour) is attention: an agent or builder is waiting on something, such as Action needed, a permission or a pick, or is working. The Action needed badge and the controls that clear it are orange.
- **Red** (`--bad`, the danger status colour) means danger: something failed, is offline, or spends or loses something if left.
- **Grey** (`--muted`, the quiet status colour) means idle. An idle state has no other colour.
- Green (`--ok`, the success status colour) keeps its meaning from [0033](0033-one-colour-constants-file-shared-by-the-hub-and-every-board.md): done or passing.

Links, focus rings and the primary button still use `--accent`, which reads as "you can act here". This narrows 0033's info: as a status, blue marks only something to read or see. 0033's "working or waiting on attention is notice" stands. The colours themselves stay in `shared/colors.css` as 0033 decided.

INT-211's amber Paused (the machine waits), red Keep going (it spends credits) and INT-219's blue reload row (a new version to see) already follow the rule. Colours that break it are listed on hub/INT-226 and change as the owner approves each.

Considered:
- blue for everything the owner must do, Action needed included. An agent waiting on a permission or a pick is attention, which the owner reads as orange; blue earns its place only for review and notice.
- a colour per actor beyond these four. The owner wants one question answered by colour, and more hues would need a legend.
