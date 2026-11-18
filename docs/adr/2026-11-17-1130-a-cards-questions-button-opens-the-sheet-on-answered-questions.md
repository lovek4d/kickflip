# A card's Questions button opens the sheet on its answered questions

Send resolves an answered question at once, so a card whose questions are all answered still shows its Questions button
while none is open. The sheet refused to open then, and the tap did nothing.

The sheet opened by a tap now opens on the topic's latest batch, each question with its answer, when nothing is open.
It still returns false for a topic that never had an answered question, and the card-following open (`auto`) still
opens only for open questions, so opening a card draws no sheet over an answered one.

## Amended: a card with only resolved questions

The board download leaves resolved questions out (2026-11-04-0128), so a card whose questions are all resolved had
nothing for the sheet to open on. Its Questions button now names the card's topic, and the sheet fetches
`api/questions?topic=<id>` on that tap and opens on the topic's latest batch, read-only. The fetched questions are held
only until the sheet closes. The button stays grey, and opening the card by itself still opens no sheet.
