# On desktop a card with no open questions opens its notes by itself

From 900px opening a card already opens its questions sheet (2026-11-16-0600). A card with none now opens its notes in the reader by the same rule: the reader carries one flag, autoNotes (app-reader.js).

- Opening a card, with no sheet open or only followed ones open, opens its notes in the reader with autoNotes true when the card has notes and no open questions. Followed notes show in place for the next card.
- A card with open questions closes followed notes for its questions sheet; a card with no notes closes them and opens nothing.
- Collapsing the card closes notes that opened by themselves. Notes or any other reader view the owner opened (a notes link, a log, a visual) stay: opening a card never replaces them, and a questions sheet the owner opened keeps the notes shut.
- A phone (under 900px) opens neither.
