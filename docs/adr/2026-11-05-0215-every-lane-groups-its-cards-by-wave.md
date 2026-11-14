# Every lane groups its cards by wave

Status: superseded by [waves are dropped; deps and Related carry order and grouping](2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md).

Waves were bands in Todo only ([waves are bands in Todo](2026-11-03-1840-waves-are-bands-in-todo.md)). Now every lane groups its cards under a header per open wave, in band order, and the cards in no wave sit last under "No wave". A wave shows a header in a lane only while it holds cards of that wave there; Todo's bands hide the same way.

Each wave header counts the wave across all lanes as x/y/k/z (Todo, In Progress, In Review, Done), the lane's own number bold in the accent colour and the rest muted; a tooltip spells them out. Stale cards count with In Progress. A lane with no card in a wave lists its cards plainly, with no "No wave" header. Notes, Triage and Implement stay in Todo's bands, where the wave is still being run.

From the prototype take B (answer gh270-waves-2).
