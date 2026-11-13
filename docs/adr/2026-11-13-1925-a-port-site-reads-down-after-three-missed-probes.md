# A port site reads down after three missed probes

The hub's reconcile probes each site it only forwards to (`serves: port`) every 2 s. One missed 800 ms connect set the route to `down`, and under load (a busy Mac, test runs) working sites flickered red.

A port site now reads `down` only after 3 probes in a row fail (about 6 s); one success reads `up` at once, and until the first probe it reads `starting`. The probe timeout is 2 s, and the sites are probed in parallel so one slow site doesn't delay the rest. A site the hub runs is unchanged: there `down` means its process crashed. The counting lives in `hub/answering.mjs`.
