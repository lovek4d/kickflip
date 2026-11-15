# A card filed held stays New until it is unheld

`item add` (and `item set --from-ask`) take `--held` or `--pick-up-at` in place of `--phase`, and refuse the two together. A card filed that way stores no phase, so it reads New, and stores `filed_held` so a card from an ask counts as sorted. The unhold (or the pick-up time) drops the hold, and the card arrives like any new card: the board launches its grill, which writes phase grilling.

Superseded by [every new ticket starts discussing](2026-11-15-1000-every-new-ticket-starts-discussing.md): a card added with no phase, held or not, starts discussing.

A card held after a round began keeps its phase and Resume relaunches that round, as before. Cards held in grilling before this (#350, #365, #393, #425) stay as they are. `filed_held` is deleted when any phase is set.
