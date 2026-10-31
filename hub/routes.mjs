export const ROUTE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Routes key plain objects in every hub state file, where `constructor` would read Object.prototype's.
export const validRoute = (route) => typeof route === 'string' && ROUTE_RE.test(route) && !(route in Object.prototype);

export function routeFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41).replace(/-+$/, '');
}

export const routeRecord = (records, route) => (Object.hasOwn(records || {}, route) ? records[route] : undefined);
