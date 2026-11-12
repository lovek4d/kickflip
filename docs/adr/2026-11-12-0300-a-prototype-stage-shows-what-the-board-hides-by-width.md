# A prototype stage shows what the board hides by width

T-90's round 3 drew its examples inside `.needs-deck`, which style.css hides from 900px (the Waiting on you pane replaces it there). On a desktop the round showed only its captions.

## Decision

- prototype.html undoes the board's width-gated hides inside `#stage`: `.needs-deck`, `.needs-pane` (laid in flow) and `.key-hint` show at every width, following the existing `#stage .kit-sidebar.sidebar` pattern. The owner's note: everything should be shown on the prototypes.
- render-check.mjs loads each take at 390px and 1280px and refuses one whose stage has an element `display: none` at one width and shown at the other, naming its class. A gate the stage rule misses fails the round instead of drawing blank.
- No `kit.deck()` helper: the deck's markup stays in app-needs.js.

Simplifying the prototype system is a separate card.
