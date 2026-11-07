# The Send bar keeps the same gap under Send as above it

#437. The Send bar (`.view-questions .bar`) is stacked above the notes' paperclips (z-index 2, over their 1), so none shows over it as a band under Send. On a phone the nav under the bar already pads the safe area through `--app-bottom`, so the bar's own bottom padding is a flat 10px there, the same as above Send. On desktop `--app-bottom` is unset and the bar's padding is `max(10px, env(safe-area-inset-bottom))`, 10px.
