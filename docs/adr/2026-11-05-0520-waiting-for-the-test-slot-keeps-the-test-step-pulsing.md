# Waiting for the test slot keeps the test step pulsing

A land that waits for the host's test slot (2026-11-05-0100-one-full-suite-at-a-time-on-the-host.md) posted a status line with no phase, so the card's bars read nothing from it. The line now carries the testing phase and reads "Testing · waiting for the test slot, <card> is running the suite": the bars sit on the test step and pulse, and the line still names the card it waits for. The line stays the card's newest until the land closes the card.

Superseded by [land suites run side by side, under a time limit](2026-11-05-0725-land-suites-run-side-by-side-under-a-time-limit.md): there is no test slot, so no land waits for one.
