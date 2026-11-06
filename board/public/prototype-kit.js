// What a prototype's take files get, on the page board/server.mjs serves from prototype.html for each topic recorded
// with board.mjs prototype add (docs/adr/2026-11-01-1448-the-board-serves-every-prototype-from-one-template.md). A take file,
// public/prototypes/<topic>/<KEY>.js, is a module:
//   export function render(stage, kit) { stage.innerHTML = kit.hub(); return () => {…} }   // the cleanup is optional
// render runs on every switch to that take with a fresh, empty stage; it may be async. The stage contains its layout
// and paint, so nothing in it, position: fixed included, can cover the viewer's bar, its ✕ or the app shell.
//   kit.sidebar(data?, {here, switching, device, head, height})  ui-sidebar.js sidebar() as an open drawer card in the
//                                       page's flow, rail width from 900px; head shows its Kickflip header
//   kit.hub(data?)                      the Hub page (view-hub.js) in flow: {usage, usageCard (HTML in its place),
//                                       afterUsage (HTML), hub, sites, polling, settings: [[id, title, sub]], header}
//   kit.cards(items?, {lanes})          board cards (ui-cards.js workLines) in their lanes, or one list with lanes false
//   kit.sheet(html, {title})            a sheet drawn in flow over a dimmed strip, not a real dialog
//   kit.toast(text)                     the page's toast
//   kit.on(target, type, fn, opts)      a listener removed on the next switch
//   kit.fake                            made-up data: at(ms), sites(), usage({claude, codex}), sidebar(), hub(), items()
//   kit.esc                             HTML escaping
// The page loads every script app.html does, in its order, so BoardUI and HubUI, every real renderer included, are globals too. A link in the stage never navigates and a form never
// submits: each toasts unless the take's own handler shows a toast. Listeners a take adds to document or window,
// and its timers, end on the next switch. Interactions must work on a tap: a phone has no hover.
// At phone width (under 600px) the page caps every box in the stage to the stage's width and stacks a take's side-by-side
// panels in one column, whether they sit in a grid, a flex row (wrapping or not) or inline-block (phoneFit below).
// A frame laid out wider than the phone (a 720px or desktop mock) keeps its own layout and scrolls sideways in its box.
// Fields in the stage are 16px, so iOS Safari doesn't zoom when one gets focus.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = globalThis.setTimeout.bind(globalThis);
  const unwait = globalThis.clearTimeout.bind(globalThis);

  // Phone width: the page caps the take's boxes to the stage (prototype.html). Panels the take puts side by side get
  // data-stack, which CSS stacks in one column, and a frame the take gives a width of 600px or more (a 720px or desktop
  // mock) gets data-wide, with its parent data-scroll, so the frame keeps its layout and scrolls sideways in its box.
  const PHONE = '(max-width: 599px)';
  const WIDE = 600;
  const px = (v) => (/^[\d.]+px$/.test(v) ? parseFloat(v) : 0);
  const rulesOf = (list) => [...list].flatMap((r) => (r.selectorText ? [r] : r.cssRules && !(r.media && !matchMedia(r.media.mediaText).matches) ? rulesOf(r.cssRules) : []));
  const styleRules = () => [...document.styleSheets].flatMap((sheet) => { try { return rulesOf(sheet.cssRules); } catch { return []; } });
  const declaredWidth = (el, rules) => Math.max(px(el.style.width), px(el.style.minWidth), ...rules.filter((r) => el.matches(r.selectorText)).map((r) => Math.max(px(r.style.width), px(r.style.minWidth))));
  const sideBySide = (a, b) => a.right <= b.left + 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 40;
  const isPanel = (el) => el.offsetWidth >= 120 && el.offsetHeight >= 80 && getComputedStyle(el).position !== 'absolute';
  function phoneFit(stage) {
    stage.querySelectorAll('[data-wide], [data-scroll], [data-stack]').forEach((el) => { delete el.dataset.wide; delete el.dataset.scroll; delete el.dataset.stack; });
    if (!matchMedia(PHONE).matches) return;
    const rules = styleRules();
    for (const el of stage.querySelectorAll('*')) {
      if (declaredWidth(el, rules) < WIDE || el.parentElement.closest('[data-wide]')) continue;
      el.dataset.wide = '';
      el.parentElement.dataset.scroll = '';
    }
    const walk = (el) => {
      const rects = [...el.children].filter(isPanel).map((c) => c.getBoundingClientRect());
      if (rects.some((a, i) => rects.some((b, j) => i < j && sideBySide(a, b)))) { el.dataset.stack = ''; return; }
      [...el.children].filter((c) => !('wide' in c.dataset)).forEach(walk);
    };
    walk(stage);
  }
  function fitPhone(stage, ends) {
    let queued = false;
    const observer = new MutationObserver(() => queue());
    const run = () => { queued = false; observer.disconnect(); phoneFit(stage); observer.observe(stage, { childList: true, subtree: true }); };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
    const mq = matchMedia(PHONE);
    mq.addEventListener('change', queue);
    ends.push(() => { observer.disconnect(); mq.removeEventListener('change', queue); });
    run();
  }

  const at = (ms) => new Date(Date.now() + ms).toISOString();
  const svg = (paths) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const siteIcon = (color, paths) => `<span class="icon" style="--c:${color}" aria-hidden="true">${svg(paths)}</span>`;
  const lanes = (...l) => `<span class="lcs">${l.map(([k, t]) => `<span class="lc lc-${k}">${t}</span>`).join('')}</span>`;
  const reading = (five, week, agoMs, resetH, weekD) => ({ at: at(-agoMs), five_hour: { used_percentage: five, resets_at: at(resetH * 3600_000), state: 'live' }, seven_day: { used_percentage: week, resets_at: at(weekD * 86400_000), state: 'live' } });
  const fake = {
    at,
    sites: () => [
      { route: 'backend-audit', title: 'Backend Audit', board: true, count: 0, created: '2026-10-22T21:47:40Z', icon: siteIcon('#8b5cf6', '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="m8.5 11 1.8 1.8 3.4-3.6"/>'), sub: lanes(['review', '3 review'], ['todo', '15 todo']) },
      { route: 'hub-orchestrator', title: 'Hub Orchestrator', board: true, count: 1, created: '2026-10-29T21:49:30Z', icon: siteIcon('#f97316', '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>'), sub: lanes(['progress', '3 doing'], ['todo', '9 todo']) },
      { route: 'ios-orchestrator', title: 'iOS Orchestrator', board: true, count: 0, created: '2026-10-22T19:19:11Z', icon: siteIcon('#3b82f6', '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>'), sub: lanes(['review', '4 review'], ['todo', '6 todo']) },
    ],
    // Percent used in each product's 5-hour window, or [5-hour, week]; null leaves that product's reading out.
    usage: ({ claude = 34, codex = 12 } = {}) => ({
      ...(claude === null ? {} : { claude: reading(...[claude, 61].flat().slice(0, 2), 2 * 60_000, 3.4, 2.6) }),
      ...(codex === null ? {} : { codex: reading(...[codex, 40].flat().slice(0, 2), 6 * 60_000, 1.2, 4.1) }),
    }),
    sidebar: () => ({ total: 1, sites: fake.sites(), hub: { tone: 'ok', word: 'healthy', detail: '3 of 3 sites up' }, notifications: { state: 'on' }, usage: fake.usage() }),
    hub: () => ({
      usage: fake.usage(),
      hub: { tone: 'ok', word: 'healthy', detail: '3 of 3 sites up' },
      sites: fake.sites(),
      polling: { title: 'Checks every minute while you’re here', lines: ['Next check 12:00pm · last 11:45am, 8 PRs, no change', 'No pushes queued.'], count: 0 },
      settings: [['notifications', 'Notifications', 'Pushes on · Off on weekends · This device on'], ['quiet', 'Quiet hours', '10:00pm – 8:00am · pushes held'],
        ['codex', 'Codex share', 'Auto'], ['rules', 'Rules for every board', '1 rule'], ['closed', 'Closed boards', 'No closed boards']],
    }),
    items: () => [
      { lane: 'review', title: 'Audit log keeps the actor on bulk updates', ref: 'INT-41', pr: { url: 'https://github.com/o/app/pull/312', number: 312, state: 'OPEN', isDraft: false, checks: { state: 'pass' } }, reviewers: ['Quinn'], review: { Quinn: { state: 'sent', since: at(-200 * 60_000) } } },
      { lane: 'progress', title: 'Rate limits per API key', ref: 'INT-43', builder: { progress: 'Writing the limiter test', at: at(-4 * 60_000) } },
      { lane: 'todo', title: 'Drop the unused lead_sources index', ref: 'INT-44', next: 'Ready to start' },
    ],
  };

  function sidebar(data = fake.sidebar(), { here = '', switching = false, device = null, head = false, height = null } = {}) {
    const style = height ? ` style="height:${Number(height)}px"` : '';
    return `<aside class="sidebar kit-sidebar${head ? ' kit-head' : ''}${switching ? ' ks-on' : ''}" aria-label="Boards"${style}>${BoardUI.sidebar(data, { here, switching, device })}</aside>`;
  }

  function hub(data = {}) {
    const d = { ...fake.hub(), header: true, ...data };
    const { row, tile, nowRow, CHEVRON } = HubUI;
    const site = (s) => row({ icon: s.icon, title: esc(s.title), sub: s.status ?? '<span class="st ok">up · listening · every link passes</span>', wrap: true, trail: CHEVRON, href: `/${s.route}/` });
    const settings = d.settings.map(([id, title, sub]) => `<button type="button" class="hub-setting" data-setting="${esc(id)}" data-kit-inert aria-haspopup="dialog"><span class="text"><span class="title">${esc(title)}</span><span class="sub">${esc(sub)}</span></span>${CHEVRON}</button>`).join('');
    const usage = d.usageCard ?? HubUI.usageCard(d.usage);
    const header = d.header ? BoardUI.header({ lead: 'logo', title: 'Hub', time: 'now', logoSrc: '/_hub/kickflip.png', logoHref: '/_hub/', settingsHref: null }) : '';
    return `<div class="hub-view view-hub kit-hub">${header}<main class="has-top"><div class="hub-status">${usage}${d.afterUsage || ''}<h2 class="label">Health</h2>
<div class="group">${row({ icon: tile('power', { ok: '#22c55e', wait: '#f59e0b' }[d.hub.tone] || '#ef4444'), title: 'Hub', sub: `<span class="st ${esc(d.hub.tone)}">${esc(d.hub.word)}</span> · ${esc(d.hub.detail)}`, wrap: true })}</div>
<h2 class="label">Boards</h2>
<div class="group">${d.sites.map(site).join('')}</div>
<p class="note">The hub runs every site and restarts one that stops. A board's links are what the hub owes it: GitHub polling, events (its session and a watcher run, or the hub can wake it), daily wakes, pushes and reviewer links. One that just broke reads settling first.</p>
<h2 class="label">Polling status</h2>
<div class="group">${nowRow(d.polling, tile('clock', '#3b82f6'))}</div></div>
<section class="hub-settings"><h2 class="label">Hub settings</h2>${settings}</section>
<div class="hub-foot"><footer>${d.sites.length} sites. Each belongs to one Claude session, which adds it with <code>/kickflip &lt;route&gt;</code>. This page refreshes every 30 seconds.<br><span class="host">mac.example.ts.net</span><br><span class="brand"><a href="https://kickflip.sh">kickflip.sh</a> / v0.4.2</span></footer></div></main></div>`;
  }

  const LANES = [['review', 'In Review'], ['progress', 'In Progress'], ['todo', 'Todo'], ['done', 'Done']];
  function card(it, i) {
    const full = { key: `w/C${i}`, id: `C${i}`, kind: 'work', internal: !it.linear && !it.ticket, ref: `C${i}`, lane: 'todo', deps: [], blockedBy: [], held: false, bumpable: false, isNew: false,
      reviewers: [], review: {}, pr: null, builder: null, next: null, ...it };
    return `<details class="item" data-key="${esc(full.key)}"><summary class="work"><span class="status ${esc(full.lane)}"></span><div class="title-wrap">${BoardUI.workLines(full)}</div></summary></details>`;
  }
  function cards(items = fake.items(), { lanes: grouped = true } = {}) {
    if (!grouped) return `<div class="view-board kit-cards"><div class="lane"><div class="list">${items.map(card).join('')}</div></div></div>`;
    return `<div class="view-board kit-cards">${LANES.map(([id, name]) => {
      const list = items.map((it, i) => [it, i]).filter(([it]) => (it.lane || 'todo') === id);
      return list.length ? `<details class="lane" data-lane="${id}" open><summary><span class="lane-name">${name}</span><span class="count">${list.length}</span></summary><div class="list">${list.map(([it, i]) => card(it, i)).join('')}</div></details>` : '';
    }).join('')}</div>`;
  }

  const sheet = (html, { title = '' } = {}) => `<div class="kit-sheet-strip"><section class="kit-sheet" role="group" aria-label="${esc(title)}"><div class="sheet-head"><h2>${esc(title)}</h2><button type="button" data-kit-inert aria-label="Close sheet">✕</button></div><div class="kit-sheet-body">${html}</div></section></div>`;

  let toasted = 0;
  function toast(text) {
    const el = document.getElementById('protoToast');
    if (!el) return;
    toasted++;
    el.textContent = text;
    el.hidden = false;
    unwait(toast.t);
    toast.t = wait(() => { el.hidden = true; }, 2600);
  }

  // What a take leaves behind: listeners on document and window, and timers, recorded while it shows. Only functions
  // made in this page count, since the app shell adds its own listeners to a framed page's document (view-frame.js).
  const ends = [];
  let live = false;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  for (const target of [window, document]) {
    Object.defineProperty(target, 'addEventListener', { configurable: true, value(type, fn, opts) {
      const self = this ?? window;
      nativeAdd.call(self, type, fn, opts);
      if (live && fn instanceof Function) ends.push(() => nativeRemove.call(self, type, fn, opts));
    } });
  }
  for (const [set, clear] of [['setTimeout', 'clearTimeout'], ['setInterval', 'clearInterval']]) {
    const native = window[set].bind(window);
    const nativeClear = window[clear].bind(window);
    window[set] = (...args) => { const id = native(...args); if (live) ends.push(() => nativeClear(id)); return id; };
  }
  const on = (target, type, fn, opts) => { nativeAdd.call(target, type, fn, opts); ends.push(() => nativeRemove.call(target, type, fn, opts)); };

  const kit = { sidebar, hub, cards, sheet, toast, on, fake, esc };

  // [element, place] for each element in stage, its place the tag and class of it and each ancestor up to the stage, with
  // a count telling apart boxes that share one, so a take drawn again finds the same box.
  function placesIn(stage) {
    const seen = new Map();
    return [...stage.querySelectorAll('*')].map((el) => {
      let path = '';
      for (let at = el; at && at !== stage; at = at.parentElement) path = `${at.tagName}.${at.className}/${path}`;
      const n = seen.get(path) || 0;
      seen.set(path, n + 1);
      return [el, `${path}#${n}`];
    });
  }
  // place → [scrollTop, scrollLeft] of each box in stage scrolled away from its start.
  const scrolledBoxes = (stage) => new Map(placesIn(stage).filter(([el]) => el.scrollTop || el.scrollLeft).map(([el, place]) => [place, [el.scrollTop, el.scrollLeft]]));

  function start(data) {
    const keys = data.takes.map((t) => t.key);
    const takes = Object.fromEntries(data.takes.map((t) => [t.key, t.label]));
    let cleanup = null;
    let shown = 0;

    // Capture runs before the app shell's own click handler on a framed page, which would open a board link.
    const inStage = (e, sel) => e.target.closest?.(`#stage ${sel}`);
    let pending = null;
    nativeAdd.call(document, 'click', (e) => {
      const a = inStage(e, 'a[href]');
      const inert = inStage(e, '[data-kit-inert]');
      if (!a && !inert) return;
      if (a) e.preventDefault();
      pending = { e, n: toasted, text: a ? `Prototype: this link opens ${a.getAttribute('href')}` : 'Prototype: nothing happens here.' };
    }, true);
    nativeAdd.call(document, 'submit', (e) => {
      if (!inStage(e, 'form')) return;
      e.preventDefault();
      pending = { e, n: toasted, text: 'Prototype: nothing is sent.' };
    }, true);
    for (const type of ['click', 'submit']) {
      nativeAdd.call(window, type, (e) => { if (pending?.e === e && pending.n === toasted) toast(pending.text); pending = null; });
    }

    async function render(key) {
      const n = ++shown;
      live = false;
      try { cleanup?.(); } catch (err) { console.error(err); }
      cleanup = null;
      ends.splice(0).forEach((end) => end());
      // A switch keeps the page where it is: the new stage holds the old one's height until the take has drawn, and
      // each box scrolled inside the take scrolls where it was once the new take has drawn the same box.
      const old = document.getElementById('stage');
      const stage = old.cloneNode(false);
      const y = window.scrollY;
      const scrolled = scrolledBoxes(old);
      stage.style.minHeight = `${old.offsetHeight}px`;
      old.replaceWith(stage);
      const settle = () => {
        if (n !== shown) return;
        stage.style.minHeight = '';
        for (const [el, place] of placesIn(stage)) {
          const at = scrolled.get(place);
          if (at) [el.scrollTop, el.scrollLeft] = at;
        }
        window.scrollTo(0, y);
      };
      document.documentElement.dataset.take = key;
      const take = data.takes.find((t) => t.key === key);
      if (!take.src) {
        stage.innerHTML = `<p class="kit-missing">Take ${esc(key)} has no file yet: write public/${esc(take.file)}, exporting render(stage, kit).</p>`;
        settle();
        return;
      }
      live = true;
      try {
        const mod = await import(new URL(take.src, location.href).href);
        if (n !== shown) return;
        const out = await mod.render(stage, kit);
        if (n === shown) cleanup = typeof out === 'function' ? out : null;
        else if (typeof out === 'function') out();
      } catch (err) {
        console.error(err);
        if (n === shown) stage.innerHTML = `<p class="kit-missing">Take ${esc(key)} failed: ${esc(err?.message || err)}</p>`;
      }
      fitPhone(stage, ends);
      settle();
    }

    return PrototypeSwitcher.mount({ takes, initial: keys[0], render });
  }

  globalThis.PrototypeKit = { ...kit, start };
})();
