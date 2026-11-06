// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
// The listener a served prototype round's page loads, in any repo: copy it next to the page in the board's base
// prototype worktree (board.mjs prototype base prints its path) and load it before the page's own script. The board's
// viewer frames the page at ?variant=<take>&state=<state>, then sends each switch as a message, so the page re-renders
// in place and keeps its typed text and scroll:
//   KickflipPrototype.on((take, state) => render(take, state))   // runs at once with the URL's, then on each switch
//   KickflipPrototype.take, KickflipPrototype.state              // the current ones; state is null with no states
// A message counts only from the framing page, shaped {kickflip: 'prototype', take, state}.
(function () {
  const params = new URLSearchParams(location.search);
  let take = params.get('variant');
  let state = params.get('state');
  const handlers = [];
  addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.kickflip !== 'prototype') return;
    take = e.data.take ?? null;
    state = e.data.state ?? null;
    for (const fn of handlers) fn(take, state);
  });
  globalThis.KickflipPrototype = {
    get take() { return take; },
    get state() { return state; },
    on(fn) { handlers.push(fn); fn(take, state); },
  };
})();
