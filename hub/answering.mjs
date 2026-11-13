// What the hub reads of a port site it only forwards to: 'starting' until the first probe, 'up' after any success,
// 'down' after MISSES probes in a row fail.
export const MISSES = 3;

export function createAnswering() {
  // route -> {state, missed}
  const sites = new Map();
  return {
    record(route, ok) {
      const s = sites.get(route) || { state: 'starting', missed: 0 };
      if (ok) Object.assign(s, { state: 'up', missed: 0 });
      else if (++s.missed >= MISSES) s.state = 'down';
      sites.set(route, s);
    },
    state: (route) => sites.get(route)?.state ?? 'starting',
    routes: () => [...sites.keys()],
    forget: (route) => sites.delete(route),
  };
}
