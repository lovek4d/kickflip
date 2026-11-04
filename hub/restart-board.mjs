// Restart on a board's row of the Hub page (docs/adr/2026-11-02-1736-a-board-restarts-from-its-row-on-the-hub-page.md).
import { listBoards, readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { routeRecord, validRoute } from './routes.mjs';
import { sessionOf, stopSession, withSessionLock } from './sessions.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// Whether the Hub page offers Restart for a site: a board whose server the hub runs from its `cmd`, with a session and
// folder recorded to resume. The hub board's session comes back in its tmux session (sessions.mjs).
export const restartable = (site) => Boolean(Array.isArray(site?.cmd) && site.cmd.length && site.port
  && site.owner?.session && site.owner.repo);

const STARTING_LIMIT = 120_000;
const POLL = 1000;

// Under the board's session lock: stops its recorded session, sets its manifest entry's restart_at as `kickflip
// restart` does, so the hub restarts its server (hub.mjs keyOf), waits for serverUp(route) (→ whether the new server
// answered), then resumes the session. A server that hasn't answered by then is still starting: portUp(port) is polled
// (every POLL ms by sleep, counted by now, onStarting(title) said once) for STARTING_LIMIT ms, and only a port that
// stays silent past that is reported, after the session is resumed.
// → {route, title: as the Hub page's row names the board, session}
export async function restartBoard(route, { serverUp, portUp, live, stop, run, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onStarting } = {}) {
  if (!validRoute(route)) refuse('Choose a board route.');
  return withSessionLock(route, async ({ resume }) => {
    const manifest = readManifest();
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) refuse('That board is not open.', 404);
    const site = routeRecord(manifest.sites, route);
    const title = site.title || route;
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
    if (!answered) {
      onStarting?.(title);
      const deadline = now() + STARTING_LIMIT;
      let up = false;
      while (!(up = await portUp(site.port)) && now() < deadline) await sleep(POLL);
      if (!up) refuse(`${title}’s session is back, but its server is still starting after 2 minutes. See kickflip logs ${route}.`, 504);
    }
    return { route, title, session };
  });
}
