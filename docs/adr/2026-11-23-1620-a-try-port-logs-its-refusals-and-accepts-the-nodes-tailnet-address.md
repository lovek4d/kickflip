# A try port logs its refusals and accepts the node's tailnet address

Status: accepted

The owner's phone got "This kickflip answers only its own address" on a Try build while the hub's own tailnet name opened
on the same phone. The refusal logged nothing, and no try port was up to probe, so the Host the relay saw is unknown.

- Each try relay request or upgrade the owner gate refuses now logs `refused <verdict> on port <n>: Host <name>, Origin <name>`
  to hub.log: names only, no port in them, path, query or cookie. The next refusal is traced from that line.
- The host check accepts the node's tailnet addresses as well as its tailnet name (the port is still ignored), so a page
  opened by address keeps working through its Try link, which reuses the page's hostname. Any other name is still refused
  (DNS rebinding).

The cause is not confirmed: the address is the one name the code could not accept that a phone can send. If the log
shows another name, this decision is revisited with it.
