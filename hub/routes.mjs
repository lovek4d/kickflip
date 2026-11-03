export const ROUTE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const validRoute = (route) => typeof route === 'string' && ROUTE_RE.test(route);

export function routeFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41).replace(/-+$/, '');
}

export const routeRecord = (records, route) => (Object.hasOwn(records || {}, route) ? records[route] : undefined);

// The board name `kickflip join --name` takes for route: its title when the title hyphenates to the route, else the
// route itself, which a join keeps the title for (docs/adr/0143-kickflip-join-adds-the-current-repository-as-a-board.md).
export const joinName = (route, title) => (title && routeFromName(title) === route ? title : route);
