# The hub session is a dev-time role

Superseded by [0147](0147-boards-run-in-the-background-and-the-hub-board-in-tmux.md): the hub board is the board whose session runs in the foreground in tmux, which `kickflip hub` attaches to, and no other rule sets it apart.

The product needs only the hub server running, with boards added in the app. The hub session is a dev-time session that builds the app from inside: it is the owning session of the hub board, the same board that receives hub changes as asks ([0041](0041-hub-changes-come-as-asks-not-improvement-rounds.md)). The owner chose this direction: "For now, eventual goal is just the hub server is spun up and the boards are added in the app. This orchestrator is for the sake of building this app from the inside."

The hub board is the one board whose manifest entry has `hub: true`. `web-ts set <route> --hub` or `web-ts join <route> --hub` sets it and clears it from any other site; `--no-hub` clears it. Code finds the hub board by the flag, never by its route, so the dev-time board can be any board, or none. With no flagged board, `web-ts hub` exits 2. The hub flags `hub-orchestrator` once as it starts, while no site has the flag, and records that run in the manifest's `migrated` list so a flag cleared later stays cleared.

`web-ts hub` opens that session in the owner's terminal, resuming its recorded session in its folder and model, or starting a fresh session that joins the board with `--hub`. Its instructions live in [hub-session.md](../hub-session.md), reached by the command's prompt, rather than a separate installed skill. It keeps the terminal's permission dialogs; board sessions started or resumed in the background keep their own prompt path ([0060](0060-background-sessions-prompts-come-to-the-phone.md)).

Features must not come to depend on the hub session, and none does: New board's session is started by the hub server itself ([0069](0069-the-hub-starts-a-new-boards-session.md)). Making the hub session a permanent product orchestrator would require the owner's development conversation to run for the app to work.
