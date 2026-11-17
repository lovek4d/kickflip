# The board menu holds Settings, Repo review and Pause, and the board's foot is gone

The board menu the board's name opens (docs/adr/2026-11-17-1500-the-board-menu-shows-how-to-join-the-orchestrator-in-a-terminal.md) lists, in order: Join in terminal, Settings, Repo review, Pause or Resume.

- **Settings** is the `settings.html` link the shell already opens as the Board Settings modal, now a menu row. It is greyed until the header's controls are on, and stays live offline, as the gear did.
- **Repo review** is the bulb's entry, shown only while the board has an `arch` (a repo). Its right side is orange "Running" while a review runs, else grey "Last review <day>" or "No review yet". It opens the same Architecture review sheet.
- **Pause / Resume** reads the hub's pause for the board. Not paused: "Pause", green "Running", opening a sheet of the duration chips Board Settings draws (`HubKit.durationPicker`), each posting `{pause}` to `api/pause`. The owner's Pause board holding: "Resume", grey "Paused until …", one tap posting `{pause: 'off'}`. A pause that isn't the owner's (the hub's, or the usage line) shows grey and can't be tapped, since Resume would not end it.

The board's foot under the lanes, with the bulb and the gear, is removed, along with its glow styling and the shared-view rule that hid them (a shared person's name opens no menu, so none of these rows is reachable there).

Pause board also stays in Board Settings: that page's section and the sidebar redraw it drives are unchanged, and the menu is a second way in.

There is no board triage control to move: Triage overnight is one hub-wide switch on the Hub's settings (docs/adr/2026-11-16-0100-one-hub-triage-overnight-switch-replaces-the-board-toggle.md). The confirmed visual left the Triage row out unless the owner said what it should do, so the menu has none.
