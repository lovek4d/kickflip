# The desktop header hides the question mark with a selector as specific as the icon rule

The question mark in the header is an `a.icon` inside `.nav`, so `.top .nav a.icon { display: inline-flex }` (#408) outranks `.top .pages-switch { display: none }`. At 900px and wider the hide is now also written as `.top .nav a.pages-switch`, which ties on specificity and comes later. The questions page's back check sits outside `.nav` and keeps the original rule.
