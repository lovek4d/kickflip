# Every status line shows its time, from one shell

Status: accepted

Owner, T-320: "Strictly every status log line should get a timestamp on it, simplify and dry". Each status-line branch of `ui-threads.js` `line()` wrote its own ` · <time>` tail, so a branch could leave it out: the ask-link line, a folded run's summary and the judgment-calls summary (which showed only "verified <time>") had none.

- `statusLine(cls, head, ts, { by, after, rest, summary })` in `ui-threads.js` writes every status line's shell: `<div class="msg status-line <cls>">`, its mark and words, then `<span class="muted">· [by · ]<time>[ · after]</span>`. With `rest` it is a closed `<details>` whose summary carries the words and time and whose body is `rest`. Every status-line kind goes through it, so a new kind gets its time without asking.
- A folded run's summary reads `<agent> · running|finished · <time>`, the time of the run's newest line. This supersedes "with nothing after" in [2026-11-10-1100](2026-11-10-1100-an-intake-run-folds-into-one-section-and-every-fold-ends-at-its-status.md) for the time only; the newest status text and counts stay off.
- Judgment calls read `<agent>'s judgment calls · N · <posted time> · verified <time>` (or `· not verified yet`), the verified state after the posted time, inside the muted tail like an agent line's eta.

Each kind keeps its classes and marks. The settings page's rules replies are `.reply` blocks, not status lines, and are unchanged.
