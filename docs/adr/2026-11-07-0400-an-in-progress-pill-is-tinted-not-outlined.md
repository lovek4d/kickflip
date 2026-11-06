# An In Progress pill is tinted, not outlined

#332 gave In Progress pills a thin orange border, which looked harsh beside the grey-outlined plain pills. Prototype rounds (#335) compared a softer border, a tint, and both; the owner chose the tint alone.

- `button.progress` keeps the plain `--line` border and mixes 12% of `--color-notice` into the pill background.
- A selected In Progress pill takes the selected border and mixes the same tint into `--accent-soft`. Its rule sits after the progress rule, so selection shows blue (the old orange border rule used to override it).
