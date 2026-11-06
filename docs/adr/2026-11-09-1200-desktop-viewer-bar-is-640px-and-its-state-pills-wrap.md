---
status: accepted
---

# On desktop the prototype viewer's bar is 640px wide, its state pills wrap, and its note field stays after a pick

#419. At 900px and up the floating bar (`.ps-pill`) and the note field are `min(640px, 100%)` wide, and the state pills wrap onto new lines instead of scrolling sideways. Under 900px the bar keeps its 460px width and scrolling pills; #403 owns the phone footer.

The owner picked 640px from the prototype `desktop-bar-419` (question `gh419-bar-width`). The owner also asked that the note field stick around when a take is picked, so it is shown for a picked take as well as for pick and change.
