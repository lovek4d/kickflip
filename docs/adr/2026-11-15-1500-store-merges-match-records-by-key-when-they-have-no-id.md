# Store merges match records by key when they have no id

merge3 merged a list per record only when every element had a string `id`; the orchestrator waits, the done archive's cards and similar lists are keyed by `key`, so concurrent writes fell to the last writer and lost records silently (T-800, from T-130's review).

merge3 now names a list's records by `id`, else `key`, when every record has the field and none repeats; otherwise the list is one value as before. No record gains an id. try.json's groups are one entry per process group (`pgid`), and a card's key can repeat, so they stay one value; the hub is that file's only writer and does not merge.
