# A card link ends with its card's lane ring

A link to a card this board knows (a ref in text, a Parent or Related to label, the Done list) ends with the same
`.status` ring its row leads with, at text size, after the id (T-189 first put it ahead of the id; the owner moved it, card #583). The ring shows the lane only: held or a fault stays on
the card. A Linear or GitHub id with no card here stays plain, with no ring.

`linkContext` carries each card's lane (`lanes`, by key) so `cardLink` in ui-links.js needs no other lookup.
