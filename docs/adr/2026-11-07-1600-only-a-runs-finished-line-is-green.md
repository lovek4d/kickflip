# Only a run's finished line is green

Supersedes `2026-11-07-1200-a-finished-runs-lines-turn-green.md`. A finished run's fold no longer turns its started and
status lines green: only the finished line is green, and the started and status lines stay orange, or a planner's blue,
after the run ends. The fold's summary mirrors the run's last line: green once the finished line exists, else orange or
blue. The fold carries no `finished` class; its `<summary>` does.
