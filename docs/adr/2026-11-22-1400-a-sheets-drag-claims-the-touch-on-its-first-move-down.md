# A sheet's drag claims the touch on its first move down

Amends 2026-11-14-1700 (swiping a sheet down drags it to dismiss). `BoardUI.swipeToDismiss` called `preventDefault` only once a drag passed its 8px slop. iOS hands the pan to the page at the first touchmove nobody cancels, and after that no touchmove can be cancelled. So whether a swipe worked came down to timing: if Safari's pan started before the finger had moved 8px, the page took it. That is the race behind "the swipe doesn't work at all, sometimes" (T-782, T-825).

- Under the slop, a move down at least as far as it moves sideways now cancels its touchmove, so the page never starts a pan. The sheet still moves only past the slop, so a tap with a little jitter doesn't nudge it.
- A first move up or sideways is left to the page: content scrolls up and rows scroll sideways as before. A stroke that starts upward and then turns down stays a scroll, since iOS has already taken it.
- A touch held mid-scroll (2026-11-18-1500) is unchanged: its takeover comes after iOS has started scrolling, when nothing can be cancelled.

T-832 tried to settle this in the iPhone Simulator (Xcode 26.0.1, iOS 26.0) and couldn't. safaridriver's touch actions deliver touchstart but never touchend or click, and the page's script stalls after a touch drag. osascript has no assistive access to rotate or click the Simulator window. So the fix follows WebKit's documented first-touchmove rule, not a recorded failing run. A throwaway logged page, run once on the owner's phone, confirms it: each touchmove's `cancelable` and `claimed`, plus the sheet's height and focus for T-826 and T-827.
