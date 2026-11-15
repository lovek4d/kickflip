# Every pending control waits in one style

This extends [a tap waits for the server to record it](2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md) from the card taps to every control that posts, on the board, the hub page, hub settings, board settings, the sidebar and their sheets.

**The rule.** A control that is waiting is disabled and keeps its colours and width. A button's content gives way to a spinner in its text colour. Nothing else on the page says "Sending…", "Saving…", "Restarting…" or "Merging…".

- **One helper.** `BoardUI.waitOn(control, promise, { group })` (`board/public/ui.js`) covers each form:
  - **A button.** The button gets `aria-busy="true"`, and `style.css` `button[aria-busy="true"]` hides its content behind a spinner. The look now keys on `aria-busy`, so markup can draw it too.
  - **A toggle, select or field.** The control keeps its face, disabled, with a `.tap-beside` spinner just before it. In a `.tk-field` the spinner goes after the field's caption, since the field sits under the caption.
  - **A group.** `group` lists the setting's other choices. They are disabled (`tap-blocked`) without a spinner while the tapped one waits. Examples: Codex share and Claude model segments, the Pause stepper, Snooze and Keep awake chips, Post it and Skip, a prompt line's answers, a lineup card's moves, a failed start's Retry and Dismiss, and the tickets controls.
- **Hub forms wait in one place.** `HubKit.forms` waits on `e.submitter`, or else on the form's toggle or field, with the form's other buttons as the group. That covers the Hub page, hub settings and Polling.
- **Long waits are drawn in markup.** Some taps start work that outlives the request. Those buttons draw `BoardUI.BUSY` (`disabled aria-busy="true"`), with their label kept, until the state the page draws from says the work is done:
  - Restart, which waits for its POST, and that POST answers once the board is back up.
  - Restart hub, until the hub answers with its new code.
  - Upgrade, while the hub's update waits for builders or runs. The pill keeps its blue (`sidebar.css`).
  - Reload.
  - Main's Retry, until main is up or fails.
  - Merge, while the session merges.
  - Reopen, Run a review, Linear's Create, This device's Turn on and Test, and the prompt line's tapped answer.
  - Close board, which waits on its POST, and the hub answers that only once it has stopped the board.
- **Status words that aren't controls** become lowercase: "triaging…" on a wave band, "starting…" and "cloning…" on a sidebar row.
- **Board settings' Done** is disabled with the same spinner while a save is out. ✕, Escape and the backdrop still close once the save lands.

The owner (2026-11-03): "Work item to audit all of the buttons that may have spinners or pending submission states … align it with the recent spinner style … I would also like the buttons to be disabled while the spinner is being shown." The owner's picks:
- the prototype `pending-buttons` take B: buttons become spinner-only, and toggles and selects keep their face with the spinner beside them;
- the spinner stays until the work is done for a tap that outlives its request;
- the whole group is disabled while one choice saves;
- the separate status lines go.

Considered:
- a spinner in place of a toggle's face (take A): a switch can't hold a spinner, and the owner chose B;
- a "saving…" word after the spinner (take C): it is the status line again;
- a separate long-wait form of `waitOn` that holds until a done signal: the page already redraws from the state that says when the work ends, so drawing `BUSY` from that state needs nothing more (a tap whose change shows only in a later board uses `BoardUI.pending`, [a tap spins until the board shows its change](2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md)), and it survives the hub page's `innerHTML` repaints, which `waitOn` doesn't see.

**Amended 2026-11-15.** A busy `.thread-more` (a lane's or a thread's Show more) draws its spinner at the left, where "Show more" starts, with no underline: the button's hover underline (a tap leaves `:hover` stuck on a phone) was still drawn in the text colour under the hidden text. Done also fetches its next archive page before the tap, once its shown cards come within one step of the cards held, so Show more seldom waits at all.

Not changed: Check GitHub stays `aria-disabled` while it spins. It sits in a lane's `<summary>`, and a disabled button there would let the tap fold the lane (`ui-header.js` `githubRefresh`).
