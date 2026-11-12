# New messages read bold blue in every lane

A card's "N new messages" is information for the owner to read, so it takes the info blue (AGENTS.md colour priority) in every lane. Action needed stays bold orange and is the only orange on the row; a red "stalled" stays rightmost.

The row's own colour is gone: `.card-alert` only sets the weight, and each word (`.card-action`, `.card-unread`, `.card-stalled`) carries its own colour. This replaces the Done-lane-only blue rule, so there are no per-lane colour rules left.
