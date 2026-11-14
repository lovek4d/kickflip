// The one icon and word every status line draws from (docs/adr/2026-11-14-2250-one-icon-and-text-helper-takes-a-shape-and-a-colour.md):
// iconText(shape, colour, text, {label}) takes a shape from ICON_SHAPES and a colour from ICON_COLOURS, the colour priority's set
// (AGENTS.md). The shape fixes the icon, its size and the gap to the word; the colour is only the colour, the icon's and the
// word's. It needs nothing else, since hub/hub.mjs renders the shell's first sidebar with it in a vm context. sidebar.css draws it.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Each shape's SVG paths; a dot and a pulse (a dot that beats on every pulse's one clock, ui-progress-bar.js onePulse) are CSS alone.
  const PATHS = {
    dot: '',
    pulse: '',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.55"/>',
    pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  };
  const ICON_SHAPES = Object.freeze(Object.keys(PATHS));
  const ICON_COLOURS = Object.freeze(['red', 'orange', 'blue', 'green', 'purple', 'grey']);
  // label: the icon's own words for a reader, for an icon that carries meaning without the text (role="img"); otherwise
  // the icon is aria-hidden. A shape or colour outside its enum is a bug in the caller, so it throws.
  function iconText(shape, colour, text, { label } = {}) {
    if (!ICON_SHAPES.includes(shape)) throw new Error(`iconText: no shape ${shape}`);
    if (!ICON_COLOURS.includes(colour)) throw new Error(`iconText: no colour ${colour}`);
    const svg = PATHS[shape] ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${PATHS[shape]}</svg>` : '';
    const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
    return `<span class="it it-${colour}"><span class="it-i it-${shape}" ${a11y}>${svg}</span>${text ? `<span class="it-w">${esc(text)}</span>` : ''}</span>`;
  }
  Object.assign(globalThis.BoardUI ||= {}, { iconText, ICON_SHAPES, ICON_COLOURS });
})();
