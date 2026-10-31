// The rows and tiles of the hub's views (view-hub.js, view-hub-settings.js, view-polling.js), which hub.css styles
// under .hub-view. Pure: each lays out words hub/views.mjs wrote, and title and sub are HTML.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TILE_PATHS = {
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    snooze: '<path d="M4 10h6l-6 8h6"/><path d="M14 4h6l-6 8h6"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  };
  const tile = (key, color) => `<span class="icon sm solid" style="--c:${color}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TILE_PATHS[key]}</svg></span>`;
  const CHEVRON = '<span class="chev" aria-hidden="true">›</span>';

  function row({ icon = '', title, sub = '', wrap = false, trail = '', href, attrs = '' }) {
    const inner = `${icon}<span class="body"><span class="text"><span class="title">${title}</span>${sub ? `<span class="sub${wrap ? ' wrap' : ''}">${sub}</span>` : ''}</span>${trail}</span>`;
    return href ? `<a class="row" href="${esc(href)}"${attrs}>${inner}</a>` : `<div class="row"${attrs}>${inner}</div>`;
  }

  // flash: {text, error} or null, a form's answer shown above the view.
  const flash = (f) => (f ? `<div class="flash${f.error ? ' error' : ''}" role="${f.error ? 'alert' : 'status'}">${esc(f.text)}</div>` : '');

  // What polling does now, the last and next check and the queue, with Send now: hub/views.mjs pollingNow's words.
  const nowRow = (now, icon = '') => row({ icon, title: esc(now.title), sub: now.lines.map((l) => `<span class="sub wrap">${esc(l)}</span>`).join(''),
    trail: `<form method="post" action="/_hub/push/flush"><button class="btn quiet" ${now.count ? '' : 'disabled'}>Send now</button></form>` });

  // This device's notifications (hub-kit.js device): state is {title, sub, action: {label, act, quiet, disabled}} or
  // null while unknown, which keeps the row hidden.
  function deviceRow(state) {
    if (!state) return `<div class="row" id="push" hidden>${tile('bell', '#ef4444')}</div>`;
    const a = state.action;
    const button = a ? `<button type="button" class="${a.quiet ? 'btn quiet' : 'btn'}" data-device="${esc(a.act)}"${a.disabled ? ' disabled' : ''}>${esc(a.label)}</button>` : '';
    return `<div class="row" id="push">${tile('bell', '#ef4444')}<span class="body"><span class="text"><span class="title">${esc(state.title)}</span><span class="sub wrap">${esc(state.sub)}</span></span>${button}</span></div>`;
  }

  globalThis.HubUI = { esc, tile, CHEVRON, row, flash, nowRow, deviceRow };
})();
