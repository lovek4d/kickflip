# Boot reads the Done archive once

The board server's start-up passes that look at `data/done-archive.json` (the status migration, the phase migration, the notes split and the dead-field strip) each read and parsed the whole file, four times a boot.

`archiveReader(site)` (store.mjs) reads it on the first ask and hands the same cards to every later one. The server makes one at start-up and passes it to those four passes; called with no reader, each reads the file as before. The two passes that write the archive write the very cards they were given, so the held copy is what the file holds. The reader lives only for the start-up passes, so nothing it holds can be edited underneath it.

Measured on the real 3.7 MB, 962-card archive: four read-and-parse runs took 92 ms, one 36 ms (provisional: taken while the host was busy, load average 18). Boot only; the request paths still read the file as they need it.
