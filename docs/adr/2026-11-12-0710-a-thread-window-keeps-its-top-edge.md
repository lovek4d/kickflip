# A thread's window keeps its top edge

An open card's thread window used to show the newest N counted messages, so withdrawing a pending message
pulled one older message out from behind Show more. The view now records the ts of the oldest line it showed
when it first drew (`from`, beside `upto`), and Show more taps move that edge back by a step. A deleted
message leaves a gap; the hidden count stays the same.
