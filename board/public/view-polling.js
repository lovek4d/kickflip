// Polling, /_hub/settings/polling?w=<HH:MM>, a view of the app shell (shell.js): the day's windows, the overnight hold
// and the daily wakes, in hub/views.mjs pollingView's words from GET /_hub/api/polling. ?w= names the window shown,
// which a tap on the day bar changes in place. Each change posts to /_hub/settings/polling and saves at once.
(function () {
  // The last data, which a return to the view paints at once.
  let last = null;
  const { esc } = HubUI;
  const ACTION = '/_hub/settings/polling';
  // Each change posts op and w, the shown window's start.
  const form = (op, w, inner, attrs = '') => `<form method="post" action="${ACTION}"${attrs}>${op ? `<input type="hidden" name="op" value="${op}">` : ''}<input type="hidden" name="w" value="${esc(w)}">${inner}</form>`;

  function dayBar(day, sel) {
    const segs = day.segments.map((g) => `<a class="seg${g.w === sel ? ' sel' : ''}${g.held ? ' held' : ''}" href="${esc(AppRouter.urlOf({ kind: 'polling', w: g.w }))}" data-w="${esc(g.w)}" style="left:${g.left};width:${g.width};--k:${g.shade}"`
      + ` aria-label="${esc(g.aria)}"${g.w === sel ? ' aria-current="true"' : ''}>${g.label ? `<span>${esc(g.label)}</span>` : ''}</a>`).join('');
    const pins = day.pins.map((p) => `<span class="pin" style="left:${p.left}" title="${esc(p.title)}" aria-hidden="true">▼</span>`).join('');
    const ticks = ['12am', '6am', '12pm', '6pm', '12am'].map((t, i) => `<span style="left:${i * 25}%">${t}</span>`).join('');
    const legend = ['<span><i style="background:var(--accent)"></i>darker checks more often</span>',
      day.held && '<span><i style="background:repeating-linear-gradient(135deg,var(--accent) 0 3px,var(--chip) 3px 5px)"></i>pushes held</span>',
      day.wakes && '<span style="color:var(--color-notice)">▼ wake</span>',
      '<span><i style="background:var(--color-danger);width:2px"></i>now</span>'].filter(Boolean).join('');
    return `<div class="day">${pins}<span class="now" style="left:${day.now}" aria-hidden="true"></span><div class="bar">${segs}</div><div class="ticks" aria-hidden="true">${ticks}</div></div><div class="legend">${legend}</div>`;
  }

  function html(d, sel, flash) {
    const { row, tile, nowRow } = HubUI;
    const w = d.windows.find((x) => x.from === sel);
    const chips = w.every.map((c) => `<button class="btn${c.on ? '' : ' quiet'}" name="value" value="${c.minutes}"${c.on ? ' aria-pressed="true"' : ''}>${esc(c.label)}</button>`).join('');
    const wakeChips = d.wakes.map((t) => `<button class="btn quiet" name="value" value="${esc(t.value)}" aria-label="Remove the ${esc(t.label)} wake">${esc(t.label)} ✕</button>`).join('');
    return `${HubUI.flash(flash)}<h2 class="label" style="margin-top:4px">Now</h2>
<div class="group">${nowRow(d.now)}</div>
<p class="note">Each check looks at every open PR on a board's card on GitHub, wakes a board's session when one changed, then sends the queued pushes. Times are this Mac's.</p>
<h2 class="label" id="day">Your day</h2>
<div class="group"><div class="block">${dayBar(d.day, w.from)}</div></div>
<p class="note">Tap a stretch of the bar to change it. Each window runs until the next one starts.</p>
<h2 class="label" id="window">${esc(w.range)}</h2>
<div class="group">
${form('from', w.from, `<label class="body"><span class="text title">Starts</span><input type="time" name="value" value="${esc(w.from)}" required data-autosave></label>`, ' class="row field"')}
${row({ title: 'Ends', sub: 'Where the next window starts', trail: `<span class="val">${esc(w.ends)}</span>` })}
${form('every', w.from, `<span class="title">Checks every</span><span class="chips">${chips}</span><span class="sub" style="margin-top:6px">${esc(w.checks)}</span>`, ' class="block"')}
${form('', w.from, `<button class="btn quiet" name="op" value="split"${w.split ? '' : ' disabled'}>Split in two</button><button class="btn quiet danger" name="op" value="remove"${w.remove ? '' : ' disabled'}>Remove</button>`, ' class="block split"')}
</div>
<h2 class="label" id="quiet">Quiet times</h2>
<div class="group">${form('hold', w.from, `${tile('moon', '#6366f1')}<label class="body"><span class="text"><span class="title">Hold pushes overnight</span><span class="sub wrap">${esc(d.hold.sub)}</span></span><input type="checkbox" name="value" value="on" class="toggle" data-submit${d.hold.on ? ' checked' : ''}></label>`, ' class="row field"')}</div>
<h2 class="label" id="wakes">Daily wakes</h2>
<div class="group"><div class="block"><span class="sub wrap">At each time, once a day, every board's session checks GitHub even when nothing changed, so the morning push and reviewer digests go out.</span>
<div class="chips">${wakeChips ? form('wake-remove', w.from, wakeChips) : ''}${form('wake-add', w.from, '<input type="time" name="value" required aria-label="New wake time"><button class="btn quiet">+ Add</button>', ' class="field"')}</div></div></div>`;
  }

  (globalThis.AppViews ||= {}).polling = {
    className: 'hub-view view-polling',
    title: () => 'Polling',
    markup: () => `${BoardUI.header({ lead: 'back', backHref: '/_hub/settings', backLabel: 'Settings', title: 'Polling', time: 'now', logoSrc: '/_hub/kickflip.png', settingsHref: '/_hub/settings' })}
<main class="has-top"></main>`,

    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const main = B.$('main');
      let sel = ctx.view?.w || null;
      let flash = null;
      const shown = () => (last.windows.some((x) => x.from === sel) ? sel : last.select);
      const paint = () => { if (last) main.innerHTML = html(last, shown(), flash); };
      // The shown window lives in the URL, so a reload or a shared link shows it too.
      const select = (w) => {
        sel = w;
        history.replaceState(history.state, '', AppRouter.urlOf({ kind: 'polling', w }));
        paint();
      };
      B.on(root, 'click', (e) => {
        const seg = e.target.closest?.('a.seg[data-w]');
        if (!seg || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        select(seg.dataset.w);
      });
      const forms = HubKit.forms(B, {
        answer(out, action) {
          if (action === ACTION) { last = out; flash = null; select(out.select); }
          else { flash = { text: out.message, error: !out.ok }; load(); }
          ctx.sidebarChanged?.();
        },
        fail(message) { flash = { text: message, error: true }; paint(); },
      });
      const load = HubKit.live(B, {
        url: () => `/_hub/api/polling${sel ? `?w=${encodeURIComponent(sel)}` : ''}`,
        paint(d) {
          if (!d) { if (!last) main.innerHTML = '<p class="note">Offline. Is the Mac awake?</p>'; return; }
          last = d;
          paint();
        },
        busy: () => forms.busy() || Boolean(root.querySelector('input:focus')),
      });
      paint();
    }),
  };
})();
