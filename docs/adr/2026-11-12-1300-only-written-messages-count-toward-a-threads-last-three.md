# Only written messages count toward a thread's last three

A message is a line someone wrote: the owner's text, Claude's or a builder's prose, a GitHub comment. Status, agent, calls, ask-link, questions, visual, move and hub lines, command lines ("Marked as staging", "Related to"), and bare request or tap lines are not messages. `isMessage` in `board/public/ui-enums.js` is the one definition; the thread window, the "N previous messages" label and the unread count (`domain.mjs` `countsUnread`) all use it.

Before, the window excluded a list of kinds, so command lines (which carry no words) took slots among the last three and hid real messages (T-150, T-195, T-110). Defining it positively keeps a new kind of system line out by default.
