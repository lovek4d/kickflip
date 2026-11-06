# A finished run's lines turn green

A run's fold (`status-fold`) takes a `finished` class once the run has a finished line, and that class turns the fold's
summary and the started and status lines inside it the green the finished line already used. A running fold keeps its
blue or orange. The board records one finish for a run (a builder record's `done`), with no failed or stopped
state, so every finished run is green and none can be told apart.
