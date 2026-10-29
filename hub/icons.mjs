// Site icons for the hub's rows: flat line icons (docs/adr/0017-site-icons-are-line-icons-from-a-built-in-set.md).
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export const ICONS = {
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  audit: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="m8.5 11 1.8 1.8 3.4-3.6"/>',
  magnifier: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  book: '<path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z"/><path d="M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z"/>',
  cap: '<path d="M21.42 10.92a1 1 0 0 0-.02-1.84L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.83l8.57 3.91a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  map: '<path d="M14.1 5.55a2 2 0 0 0 1.8 0l3.65-1.83A1 1 0 0 1 21 4.62v12.76a1 1 0 0 1-.55.9l-4.56 2.27a2 2 0 0 1-1.78 0l-4.22-2.1a2 2 0 0 0-1.78 0l-3.66 1.83A1 1 0 0 1 3 19.38V6.62a1 1 0 0 1 .55-.9l4.56-2.27a2 2 0 0 1 1.78 0z"/><path d="M15 5.76v15"/><path d="M9 3.24v15"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  car: '<path d="M19 17h2a1 1 0 0 0 1-1v-3a2 2 0 0 0-1.5-1.9C18.7 10.6 16 10 16 10l-2.2-2.3A2.5 2.5 0 0 0 12 7H5a1.6 1.6 0 0 0-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4a1 1 0 0 0 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9.5V3"/><path d="M7 15h10"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
};
export const ICON_KEYS = Object.keys(ICONS);

// Earlier entries win, so "backend-audit" reads as an audit and "Sync V2.1 course" as a book.
const KEYWORDS = [
  ['phone', ['ios', 'iphone', 'phone', 'mobile', 'android']],
  ['audit', ['audit', 'review', 'inspect']],
  ['magnifier', ['search', 'research', 'find', 'explore', 'investigate']],
  ['book', ['learn', 'course', 'lesson', 'lessons', 'docs', 'book', 'guide', 'teach', 'study']],
  ['cap', ['school', 'class', 'training', 'tutor']],
  ['chart', ['metrics', 'dashboard', 'stats', 'analytics', 'chart', 'report', 'reports']],
  ['chat', ['chat', 'ask', 'questions', 'qa', 'talk', 'voice']],
  ['calendar', ['calendar', 'schedule', 'agenda']],
  ['map', ['map', 'maps', 'routing', 'trip', 'travel']],
  ['flask', ['prototype', 'prototypes', 'experiment', 'lab']],
  ['terminal', ['cli', 'shell', 'terminal', 'script', 'scripts']],
  ['code', ['code', 'pr', 'prs', 'build', 'dev', 'wave', 'waves']],
  ['server', ['backend', 'server', 'api', 'db', 'database', 'sync']],
  ['car', ['car', 'cars', 'vehicle', 'vehicles', 'inventory']],
  ['wrench', ['tools', 'tool', 'fix', 'ops', 'setup']],
  ['bell', ['alerts', 'notifications', 'notify']],
  ['list', ['todo', 'todos', 'tasks', 'checklist', 'board']],
];

export function iconKey(route, site = {}) {
  if (Object.hasOwn(ICONS, site.icon || '')) return site.icon;
  const words = new Set(`${route} ${site.title || ''}`.toLowerCase().split(/[^a-z0-9]+/));
  return KEYWORDS.find(([, ws]) => ws.some((w) => words.has(w)))?.[0] || null;
}

// Each is drawn as a line icon on an 18% tint of itself, on a light or a dark panel.
const ICON_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5', '#b45309'];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function siteIcon(route, site = {}) {
  const hash = [...route].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 0);
  const color = COLOR_RE.test(site.color || '') ? site.color : ICON_COLORS[hash % ICON_COLORS.length];
  const key = iconKey(route, site);
  const glyph = key
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`
    : esc([...(site.title || route)][0].toUpperCase());
  return `<span class="icon${key ? '' : ' letter'}" style="--c:${esc(color)}" aria-hidden="true"${key ? ` data-icon="${key}"` : ''}>${glyph}</span>`;
}
