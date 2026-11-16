// Talks to the site's server (../server.mjs) from any page. Include it with a
// relative path, e.g. <script src="claude.js"></script> or "../claude.js":
// its own URL tells it the site's root, so links survive the /<route> prefix.
//   ClaudeSite.url('notes.html')        absolute URL under the site root
//   await ClaudeSite.send(kind, data, {signal})
//                                       sends same-origin application/json, records an event and wakes the owning session → {id};
//                                       a refusal throws with .status and .reason, the server's {error} or '', and no
//                                       answer at all (the host out of reach) throws with .unreachable; signal aborts it
//   await ClaudeSite.events({kind})     events newest first, each with .reply ({html} or {json}) or null
//   ClaudeSite.watch(fn, {kind})        calls fn(events) now and on change; polls every 10 s while
//                                       any event waits for a reply, else every 60 s; returns stop()
//   ClaudeSite.syncBadge()              sets the Home Screen app's badge to what waits on the owner
//                                       across every site, from the hub's /_hub/needs.json
//   ClaudeSite.site('/<route>')         the same API for another site on this hub, its root resolved
//                                       against this page, so one page can talk to several sites
window.ClaudeSite = (function () {
  function site(base) {
    const root = new URL(base, location.href).href.replace(/\/+$/, '');
    const url = (p) => root + '/' + String(p).replace(/^\/+/, '');

    async function send(kind, data, { signal } = {}) {
      const r = await fetch(url('_claude/events'), { method: 'POST', mode: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(data || {}), kind }), signal })
        .catch((e) => { throw signal?.aborted ? e : Object.assign(e, { unreachable: true }); });
      if (!r.ok) throw Object.assign(new Error('send failed: ' + r.status), { status: r.status, reason: (await r.json().catch(() => null))?.error || '' });
      return r.json();
    }

    async function events(opts) {
      const q = new URLSearchParams();
      if (opts && opts.kind) q.set('kind', opts.kind);
      if (opts && opts.limit) q.set('limit', String(opts.limit));
      const r = await fetch(url('_claude/events') + (q.toString() ? '?' + q : ''), { cache: 'no-store' });
      if (!r.ok) throw new Error('events failed: ' + r.status);
      return r.json();
    }

    function watch(fn, opts) {
      let timer, last = '', stopped = false;
      async function tick() {
        clearTimeout(timer);
        if (stopped) return;
        let pending = false;
        try {
          const list = await events(opts);
          const s = JSON.stringify(list);
          if (s !== last) { last = s; fn(list); }
          pending = list.some((e) => !e.reply);
        } catch (e) { fn(null, e); }
        if (!stopped) timer = setTimeout(tick, pending ? 10000 : 60000);
      }
      const onVisible = () => { if (!document.hidden) tick(); };
      document.addEventListener('visibilitychange', onVisible);
      tick();
      return { refresh: tick, stop() { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); } };
    }

    // The badge covers every site, so its count comes from the hub, not from this site.
    async function syncBadge() {
      if (!('setAppBadge' in navigator)) return;
      try {
        const { total } = await (await fetch('/_hub/needs.json', { cache: 'no-store' })).json();
        if (typeof total === 'number') await (total ? navigator.setAppBadge(total) : navigator.clearAppBadge());
      } catch { /* outside the hub, or badges not allowed */ }
    }

    return { root, url, send, events, watch, syncBadge, site };
  }

  const src = (document.currentScript && document.currentScript.src) || location.href;
  return site(src.replace(/\/claude\.js(?:[?#].*)?$/, ''));
})();
