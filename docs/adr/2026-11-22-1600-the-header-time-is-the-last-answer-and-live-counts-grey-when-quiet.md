# The header time is the host's last answer, and live counts grey when it is quiet

The header's time used to move only on a refresh tap or a change signal that brought something new, so a tab coming back
(a poll load) showed fresh "(2m)" live counts beside an old "12 min". It now moves on every answer from the host: a board
load (a 304 included) or a tap's answer. Past 5 minutes without one the board root takes `quiet`, which greys every
`[data-since]` count and stills its pulse until the next answer.

The header's own `late` mark (60 seconds) stays; it warns early, the grey says the counts can no longer be trusted.

Left out: the server-built durations (the Hub row's "restarted 5m ago", the load sheet's process ages) still go as words,
frozen when built.
