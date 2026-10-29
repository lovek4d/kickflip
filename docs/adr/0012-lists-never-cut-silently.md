# Lists never cut silently

A board page shows every item a list holds: every pending ask, every reply, every question it needs. When a read can't hold everything, the page says how many it shows.

The one fixed cap is the events API's 500 per read (`board/server.mjs`). A page that reads events asks for 500, and says "Showing the newest 500" when a read comes back full. Text doesn't cut either: every line on a card wraps rather than ending in an ellipsis (owner ask, 2026-10-23).

The asks box showed the five newest asks, read from the newest 30. A sixth pending ask dropped off the board while it still waited on Claude. The owner asked for no list to cut at a number without saying so (ask on 2026-10-23).

Done shows the last 7 days of work cards and follow-ups, and folds the rest under one "Older" row, newest first, which stays open once opened. The owner chose that fold in round `site-v13`, so it isn't a silent cut either. No ask leaves the board by age ([0016](0016-every-ask-is-a-card.md)).

A finished wave, one with work items and follow-ups that are all merged, done or dropped, folds the same way: its Done cards, done follow-ups included, leave the open list and sit under one row named for the wave, such as "Shared contact eligibility 8", with "· N dropped" when any were. The row opens to its cards, newest first, and stays open once opened. Wave rows come after Done's open cards and before "Older", newest wave first. A finished wave leaves the wave filter and its bar. An open follow-up keeps its wave unfinished, so filing one reopens a finished wave ([0034](0034-follow-ups-are-todo-cards-of-their-wave.md)). The owner chose one row per wave in round `site-v18`, after finished waves' cards filled Done.

Answered asks fold like a finished wave, whatever their age: one "Asks" row, first among Done's rows, newest ask first (owner ask, card INT-79). Every fold is an inset box inside its lane's list, headed by its name then its count with no icon, so it reads as part of that lane rather than another lane (owner asks, cards INT-83 and INT-86, prototype take C).
