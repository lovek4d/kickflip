# The permission hook waits for a slow hub to take its prompt

The PermissionRequest hook of a background session (hub/permission-hook.mjs) posts the prompt to the hub, then long-polls for the owner's answer. The post had a 5 s limit, and a hub slower than that was treated as unreachable: the hook denied with "the hub can't be reached", and the session had to ask again as an open question. On a loaded host the hub was only slow, and boards.test 804 and prompts.test 422 could flip on load (docs/test-determinism-audit.md).

The post now has no limit of its own. A hub that is down refuses at once, so that case still denies straight away; a slow hub is waited for. The hook's whole run is still bounded by its `HARD_STOP` (the longest wait plus 30 s), which ends any wait, this one included, with a deny before Claude Code's hook timeout, so a hub that takes the connection and never answers costs that wait rather than 5 s. The long-poll's per-request limit and the 2 s retry pace stay: they only retry, so a slow host changes when the answer arrives, not what it is.

Test: hub/prompts.test.mjs, with a preloaded fetch that cuts off a post carrying a time limit.
