# A card link starts with its card's lane ring

A link to a card this board knows (a ref in text, a Parent or Related to label, the Done list) starts with the same
`.status` ring its row leads with, at text size, then the id. The ring shows the lane only: held or a fault stays on
the card. A Linear or GitHub id with no card here stays plain, with no ring.

`linkContext` carries each card's lane (`lanes`, by key) so `cardLink` in ui-links.js needs no other lookup.
