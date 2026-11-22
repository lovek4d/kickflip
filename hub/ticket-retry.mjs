// docs/adr/2026-11-21-2349-a-failed-ticket-move-is-retried-on-the-hubs-poll-and-an-untagged-release-offers-its-tag.md
// The ticket retry, run on each of the hub's checks (github.mjs checkGitHub): every card whose ticket move failed
// (board/cards.mjs keeps it as ticket_retry) tries the move again, until it goes through. A try that fails again says
// nothing more on the card, and the next check tries once more.
import { retryTicketMove } from '../board/cards.mjs';

// boards: boards.mjs listBoards. failed: the check's failure list. ctx: moveTicket's, for a test's stand-ins.
export async function runTicketRetries(boards, failed, ctx = {}) {
  for (const board of boards) {
    for (const { slug, itemFile } of board.files) {
      for (const item of itemFile.items) {
        if (!item.ticket_retry) continue;
        try { await retryTicketMove(board.dir, `${slug}/${item.id}`, ctx); }
        catch (err) { failed.push(`${board.route}: could not retry ${slug}/${item.id}'s ticket move (${err.message})`); }
      }
    }
  }
}
