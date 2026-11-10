# One board's fetch or pull failing leaves the rest of the poll running

Paddock Web's Main pull record stayed frozen for days: no poll reached `pullMain` for it. In `runPoll`, `fetchTryBranches` was the one step not wrapped, so a throw rejected the whole poll before the pull, and a throw in one board's turn in `pullMains` skipped every board after it.

Now `fetchTryBranches` and `pullMains` catch each board's failure and log it (`fetch /<route> failed:`, `pull /<route> failed:`), and `runPoll` wraps both `fetchTryBranches` calls like its sibling steps. One board's failure no longer skips the other boards or the steps after.

The specific cause on Paddock Web's Mac is not known; its session was to post the diagnosis (T-16, T-20 notes) and had not when this was built.
