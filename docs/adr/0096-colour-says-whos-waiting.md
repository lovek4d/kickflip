# Colour says who's waiting

The owner set the rule on hub/INT-226: a colour on the hub or a board says whether something is a fault, needs attention or is being worked on, is there for the owner to read or see, or is idle.

- **Red** (`--bad`, the danger status colour) is for faults: something failed, is down or not listening, or spends or loses something if left, such as Keep going past the pause line. The one exception is the sidebar's "N need you", which stays red as the strongest call on the owner.
- **Orange** (`--warn`, the notice status colour) is attention and work, someone's turn: Action needed and the controls that clear it, the Needs you box, a New card, a card's Next line while it is someone's turn, a builder's line, Paused, and the sidebar's Working, Building, Starting and "N doing".
- **Blue** (`--accent`, the info status colour) is only for review and notice, something for the owner to read or see: an unread review, a new version to reload, Turn on notifications, switch mode's keys, and the flash on a line that changed since the last visit.
- **Grey** (`--muted`, the quiet status colour) is idle, and an idle state takes no other colour: ticket ids, Task, bumped, a merged PR's name, the Next line of a Todo, Done or held card, the Done ring, Stopped and Asleep, usage that is fine, and the hub's settings icons.
- Green (`--ok`, the success status colour) keeps its meaning from [0033](0033-one-colour-constants-file-shared-by-the-hub-and-every-board.md): done or passing.

Links, focus rings and the primary button still use `--accent`, which reads as "you can act here". This narrows 0033's info: as a status, blue marks only something to read or see. The colours themselves stay in `shared/colors.css` as 0033 decided.

Considered:
- blue for everything the owner must do, Action needed included. An agent waiting on a permission or a pick is attention, which the owner reads as orange; blue earns its place only for review and notice.
- red for Action needed, as a step up from orange. Red would then mark a normal wait as well as a fault, and a fault would no longer stand out.
- orange for the sidebar's "N need you", like the Needs you box it counts. The owner kept it red, a higher level of attention across every board.
- a colour per actor beyond these four. The owner wants one question answered by colour, and more hues would need a legend.
