# A message sorts above the status line it causes

The owner's Implement message and the "Marked as staging" line it causes are written at the same instant, so they share a ts. threadOf merged stored lines before events and sorted stably by ts, which put the line first.

On a tie, threadOf now sorts any message above any status line (status, move, hub, ask-link and request lines such as taps). One comparator in the sort, not a per-writer timestamp nudge. An agent start still sorts above the status line `builder start` writes, since both rank the same and the stable sort keeps the array order.
