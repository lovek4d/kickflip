// Restart on a board's row of the Hub page (docs/adr/0121-a-board-restarts-from-its-row-on-the-hub-page.md).
import { listBoards, readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { routeRecord, validRoute } from './routes.mjs';
import { sessionOf, stopSession, withSessionLock } from './sessions.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// Whether the Hub page offers Restart for a site: a board whose server the hub runs from its `cmd`, with a session and
// folder recorded to resume, and not the hub board, whose session runs in the owner's terminal (`kickflip hub`) and
// would come back in the background.
export const restartable = (site) => Boolean(Array.isArray(site?.cmd) && site.cmd.length && site.port && site.hub !== true
  && site.owner?.session && site.owner.repo);

// Under the board's session lock: stops its recorded session, sets its manifest entry's restart_at as `kickflip
// restart` does, so the hub restarts its server (hub.mjs keyOf), waits for serverUp(route) (→ whether the new server
// answered), then resumes the session. A server that never answers is reported after the session is resumed.
// → {route, title: as the Hub page's row names the board, session}
export async function restartBoard(route, { serverUp, live, stop, run } = {}) {
  if (!validRoute(route)) refuse('Choose a board route.');
  return withSessionLock(route, async ({ resume }) => {
    const manifest = readManifest();
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) refuse('That board is not open.', 404);
    const site = routeRecord(manifest.sites, route);
    const title = site.title || route;
    if (site.hub === true) refuse('The hub board’s session runs in your terminal; restart it there with kickflip hub.', 409);
    if (!restartable(site)) refuse(`${title} has no server the hub runs or no session to resume.`, 409);
    const shared = listBoards(manifest).filter((other) => other.route !== route && other.owner?.session === site.owner.session);
    if (shared.length) refuse(`This session is also recorded by ${shared.map((other) => `${other.title} (/${other.route})`).join(', ')}; restart refused.`, 409);
    await stopSession(sessionOf(manifest, route), { live, stop });
    await withManifestLock(async () => {
      const m = readManifest();
      const current = routeRecord(m.sites, route);
      if (!current) refuse('That board is not open.', 404);
      current.restart_at = Date.now();
      await writeManifest(m);
    });
    const answered = await serverUp(route);
    const { session } = await resume({ run, live });
    if (!answered) refuse(`${title}’s session is back, but its server hasn’t answered yet. See kickflip logs ${route}.`, 504);
    return { route, title, session };
  });
}
