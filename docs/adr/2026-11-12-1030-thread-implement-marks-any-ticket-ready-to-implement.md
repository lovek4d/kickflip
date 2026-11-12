# `thread --implement` marks any ticket ready to implement

[`reply --implement`](2026-11-12-0700-reply-implement-marks-a-card-ready-to-implement.md) only takes a ticket an ask became, so a ticket the orchestrator filed itself could not get the orange Implement. `thread <card> --text <t> --implement` sets the same `waits_on_owner {on: implement}` mark, as `thread --close` already sets `close`.

- It is refused with `--close`, and with `--who` or `--via`: it is the orchestrator marking a card.
- SKILL.md names `thread --implement` and `thread --close` for any ticket, `reply` for an ask's card.
