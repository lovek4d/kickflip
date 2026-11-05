# The Questions page bar docks on the keyboard while you type

With a text field focused and the keyboard up, the Questions page's sticky bar followed the layout viewport and lagged behind the page when scrolling. The owner picked take B of prototype keyboard-bar (#303): the bar becomes one compact row (status and Send), fixed at `bottom: var(--kb)` from visualViewport, and the + is hidden. On blur the bar returns to its sticky place.

Not checked on a phone: only the class and CSS wiring are tested, since a desktop frame can't reproduce iOS's late visualViewport reports.
