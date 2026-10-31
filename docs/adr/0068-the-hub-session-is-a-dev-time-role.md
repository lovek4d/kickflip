# The hub session is a dev-time role

The product needs only the hub server running, with boards added in the app. The hub session is a dev-time session that builds the app from inside: it is the owning session of the `hub-orchestrator` board, the same board that receives hub changes as asks ([0041](0041-hub-changes-come-as-asks-not-improvement-rounds.md)). The owner chose this direction: "For now, eventual goal is just the hub server is spun up and the boards are added in the app. This orchestrator is for the sake of building this app from the inside."

`web-ts hub` opens that session in the owner's terminal, resuming its recorded session in its folder and model, or starting a fresh session that joins the board. Its instructions live in [hub-session.md](../hub-session.md), reached by the command's prompt, rather than a separate installed skill. It keeps the terminal's permission dialogs; board sessions started or resumed in the background keep their own prompt path ([0060](0060-background-sessions-prompts-come-to-the-phone.md)).

Features must not come to depend on the hub session. New board's structured ask to it is the one current dependency: replace it with the hub server starting the board session itself. Making the hub session a permanent product orchestrator would require the owner's development conversation to run for the app to work.
