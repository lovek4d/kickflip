# A toast centres on the lanes

From 900px the toast stack centred on the whole window, so on the board it straddled the lanes and the pane. A toast cannot know its pane (`toast(text)` takes text only, most callers toast after an await, some toasts have no pane), so no per-toast origin is carried.

Decision: from 900px every toast centres horizontally on the lanes, the room between the sidebar and the pane's left edge, whatever raised it; the right pane never holds a toast. A page without a pane centres on the room right of the sidebar. Below 900px a toast centres on the phone, as before. One custom property, `--toast-centre`, is read by `.toast-stack` at every width.
