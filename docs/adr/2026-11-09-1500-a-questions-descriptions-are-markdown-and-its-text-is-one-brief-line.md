# A question's descriptions are markdown and its text is one brief line

A question's `context` and each option's `detail` render as markdown (BoardUI.markdown, the notes reader's renderer) on the open questions page, the desktop pane and the phone deck, with compact styles: headings at body size, tight blocks. The question line itself stays plain text with ref links.

`question add` refuses a `question` longer than `BRIEF_LINE_LIMIT` (100 characters, hub-lines.mjs, renamed from `STATUS_LIMIT` and shared with status lines), naming the question and its length and pointing the detail at `context` and the option details. Refused, never cut, as #426 ruled for status lines. Questions already stored are left as they are; only new ones are checked. The grill and prototype briefs and SKILL.md tell planners the same.
