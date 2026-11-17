import fs from 'node:fs';
import { carryCursor, isBoardSite, listBoards, readManifest, watcherCursor, withManifestLock, writeManifest } from './boards.mjs';
import { routeRecord, validRoute } from './routes.mjs';
import { stopSession, withSessionLock } from './sessions.mjs';
import { liveSessions } from './live.mjs';
import { openBoardBuilders } from '../board/runs.mjs';
import { closeBoardBuilders } from '../board/runs.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const checkRoute = (route) => { if (!validRoute(route)) refuse('Choose a board route.'); };

function boardOf(route, manifest) {
  checkRoute(route);
  const board = listBoards(manifest).find((b) => b.route === route);
  if (!board) refuse('That board is not open.', 404);
  return board;
}

export async function boardClosure(route, manifest = readManifest()) {
  const board = boardOf(route, manifest);
  return { route, title: board.title, prs: board.prs, builders: await openBoardBuilders(board.dir) };
}

export function closedBoards(manifest = readManifest()) {
  return Object.entries(manifest.closed || {}).filter(([, entry]) => isBoardSite(entry?.site))
    .map(([route, entry]) => ({ route, title: entry.title || entry.site.title || route, closedAt: entry.closed_at, dir: entry.site.dir }));
}

export async function closeBoard(route, name, { live, stop } = {}) {
  checkRoute(route);
  return withSessionLock(route, () => withManifestLock(async () => {
    const manifest = readManifest();
    const board = boardOf(route, manifest);
    const site = routeRecord(manifest.sites, route);
    if (name !== board.title) refuse('Type the board’s name exactly to close it.');
    if (routeRecord(manifest.closed, route)) refuse('That route already has a closed board.', 409);
    const shared = site.owner?.session && listBoards(manifest).filter((other) => other.route !== route && other.owner?.session === site.owner.session);
    if (shared?.length) refuse(`This session is also recorded by ${shared.map((other) => `${other.title} (/${other.route})`).join(', ')}; close refused.`, 409);
    const cursor = watcherCursor(board);
    await stopSession(site.owner, { live, stop });
    const builders = await closeBoardBuilders(board.dir);
    manifest.closed = { ...manifest.closed, [route]: { site, title: board.title, cursor, closed_at: new Date().toISOString() } };
    delete manifest.sites[route];
    await writeManifest(manifest);
    return { route, filesKept: site.dir, buildersClosed: builders.length, next: '/_hub/' };
  }));
}

export async function reopenBoard(route, { run, tmux, live } = {}) {
  checkRoute(route);
  return withSessionLock(route, async ({ resume }) => {
    const saved = await withManifestLock(async () => {
      const manifest = readManifest();
      const entry = routeRecord(manifest.closed, route);
      if (!isBoardSite(entry?.site)) refuse('That board is not closed.', 404);
      if (routeRecord(manifest.sites, route) || routeRecord(manifest.starting, route)) refuse('That route is already in use.', 409);
      if (Object.values(manifest.sites || {}).some((site) => site.port === entry.site.port)) refuse('The board’s recorded port is in use by another site.', 409);
      if (!fs.statSync(entry.site.dir, { throwIfNoEntry: false })?.isDirectory()) refuse('The board’s folder is missing.', 409);
      if (!entry.site.owner?.session || !entry.site.owner.repo) refuse('The board has no recorded session and folder to resume.', 409);
      manifest.sites ||= {};
      manifest.sites[route] = entry.site;
      if (entry.cursor) carryCursor(boardOf(route, manifest), { from: entry.site.owner.session, mark: entry.cursor });
      delete manifest.closed[route];
      if (!Object.keys(manifest.closed).length) delete manifest.closed;
      await writeManifest(manifest);
      return entry;
    });
    try {
      const session = await resume({ run, tmux, live, mark: saved.cursor });
      return { route, session: session.session };
    } catch (error) {
      const current = routeRecord(readManifest().sites, route);
      if (error.reason === 'live' && current?.owner?.session && (live || liveSessions)()?.has(current.owner.session)) return { route, session: current.owner.session };
      await withManifestLock(async () => {
        const manifest = readManifest();
        if (JSON.stringify(routeRecord(manifest.sites, route)) !== JSON.stringify(saved.site)) return;
        delete manifest.sites[route];
        manifest.closed = { ...manifest.closed, [route]: saved };
        await writeManifest(manifest);
      });
      throw error;
    }
  });
}
