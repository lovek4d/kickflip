# A dead headless builder is relaunched once

On 11/04 at 12:07Z the server's pull launched headless builders for #211 and #212 as Claude usage crossed the pause line. Each builder's `builder start` refused with "Work is paused" and the process exited, leaving its record open until builder-stalled fired 30 minutes later.

The pause check at the pull and the one in `builder start` are already the same line (`readUsageGate().state === 'paused'`). The gap is time: usage can cross the line between the pull and the launched builder's start. So the launch itself rechecks the gate, and the server keeps what it launched in `data/headless-builders.json {key: {model, pid, relaunched}}`.

- A launch that finds usage paused is held (pid null) and goes out once the pause lifts.
- Once a minute, while not paused, a tracked build whose process has exited with its record still open launches again once. If that one dies too, the card gets a thread line and a `card-build` event, so the orchestrator launches it.
- A lander's launch drops the card's entry, since the lander now owns the open record. A lander, and a rebase run, keep their own relaunch-once count in data/landers.json and data/rebases.json ([one land step decides a verified card's land](2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md)).
