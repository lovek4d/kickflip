# Tapping the marked option clears an unsent pick

On the open questions page and the desktop pane, a tap (or Space) on the already-marked radio clears the pick, so an accidental pick can be taken back without a "no answer" option. Owner chose this over a note line or a Clear link (prototype round 1, take A).

- A cleared pick is `draft.choice === null`; `'choice' in draft` decides, not `??`, so a cleared pick does not fall back to the last answer or the overnight triage suggestion (`choiceOf`, `pending`).
- A cleared pick with no note stays open and unsent; only a note sends an empty question.
- The phone deck is unchanged: its tap on the marked option still sends (#430). It no longer counts a cleared draft as drafted.
- A sent answer is taken back by the Resolved badge, not by this.
