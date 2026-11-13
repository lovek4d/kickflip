# An exact repeat within 30 seconds is skipped

An item-message or ask with no sendId (a page send carries its own, which guards it) whose text, author (`shared_by`) and card match one already recorded in the last 30 seconds is answered with the recorded event's id and writes nothing: no thread line, no event, no push. After 30 seconds the same text goes through. The sendId skip stays; this catches the repeats that carry no sendId (four since 11/12, 1–12 s apart).

The owner first picked 2 minutes, then changed it to 30 seconds so a deliberate second "Bump" soon after still goes through.
