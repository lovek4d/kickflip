# The reviewer picker searches one list and says what it waits on

Board settings' Reviewers picker was two side-by-side lists (Slack member, GitHub login). It now has one search over the Slack members; tapping one shows a chip and a GitHub login field holding a guess (first+last, first, last, or first initial + last matched against the board repo's collaborators), editable, with Add off until a login is there.

The stuck "Board restarting… / Loading…" came from `GET api/reviewer-people` answering slowly: Slack (15s per page) and `gh` (90s) were asked one after the other, so the hub's proxy could give up with a 5xx or non-JSON body, which `fetchJSON` retries as a restart. The endpoint itself has existed since #193. The server now asks both at once and gives up on either after 12s with its reason as the problem text. The page names "Board restarting…" only when `downOf` says the hub marked a restart; any other failure ends in "Couldn't load the list" with Retry.
