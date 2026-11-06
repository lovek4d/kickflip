# A busy host shows only on the Hub row and the logo dot

Status: accepted (owner, 11/06 12:34, card #396)

A busy host holds every board's new work (2026-11-06-0106-a-busy-mac-holds-new-work.md). It had shown as the word "busy" in place of the header's time, an orange header, and "busy" on every board row.

Now:
- The header never changes for a busy host. It keeps reading the data's age (header-time decision: only colour and spin move, and a busy host moves neither). A paused board keeps its amber header as before.
- The sidebar says "busy" on the Hub row alone, detail "the host is busy". Boards keep their own status, because busy only means new tasks aren't being pulled in.
- The logo carries a dot like the blue update dot: orange for a busy hub, red for a broken one (hub tone down). Red reads before orange before blue. A usage pause reads before busy.
- No user-facing wording says "Mac": it says "host". Code comments, this ADR's predecessor's file name and "Mac" as a device kind (push, the ⌘ hint) stay.
