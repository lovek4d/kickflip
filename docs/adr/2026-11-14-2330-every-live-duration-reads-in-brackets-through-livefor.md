# Every live duration reads in brackets, through one helper

A live status shows how long it has been going as "(3m)" after its words: "thinking… (3m)", "orchestrator review (3m)",
"waiting for orchestrator (14m)", a builder's line, a stopped land, "Host busy (31m)". `BoardUI.liveFor(since)`
(ui-progress-bar.js, which every page drawing a status and the hub's sidebar vm load) is the one place that draws it: "(3m)", "(1h 5m)", "(2h)", "(1d 2h)", and nothing under a minute or
with no start. ui.js `withCount(words, since)` joins the words and the count.

Not durations, so untouched: a time of day, a past "ago" (pushed, posted, checked) and the main branch's commit age.
A starting board's step seconds stay as they are, as liveFor counts minutes.
