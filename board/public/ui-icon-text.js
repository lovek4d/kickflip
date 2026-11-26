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
    // The thread status lines' marks (ui.js MARK_ICONS): a command's eye, flame and image, a retry, a move, a chat bubble,
    // code brackets, a flag, a barred circle, a play, a link, a created square, a circled check, a reopen, a reply, a chevron and a question mark.
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    flame: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    retry: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    move: '<path d="M3 7h14"/><path d="m13 3 4 4-4 4"/><path d="M21 17H7"/><path d="m11 13-4 4 4 4"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    code: '<path d="m8 6-6 6 6 6"/><path d="m16 6 6 6-6 6"/>',
    flag: '<path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/>',
    blocked: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    created: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8"/><path d="M8 12h8"/>',
    'circle-check': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    reopen: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    question: '<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    // A task's Reminder lines.
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    // A card's Tag… item, its picker and its Tagged and Untagged lines.
    tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1"/>',
  };
  const ICON_SHAPES = Object.freeze(Object.keys(PATHS));
  const ICON_COLOURS = Object.freeze(['red', 'orange', 'blue', 'green', 'purple', 'grey']);
  // 'current' is no seventh colour in the priority: it takes the colour of the line it sits in (a status line's tone, a
  // card's lane), for the working dots and thread marks whose colour a parent's class already sets.
  const COLOURS_ALLOWED = Object.freeze([...ICON_COLOURS, 'current']);
  // label: the icon's own words for a reader, for an icon that carries meaning without the text (role="img"); otherwise
  // the icon is aria-hidden. A shape or colour outside its enum is a bug in the caller, so it throws.
  function iconText(shape, colour, text, { label } = {}) {
    if (!ICON_SHAPES.includes(shape)) throw new Error(`iconText: no shape ${shape}`);
    if (!COLOURS_ALLOWED.includes(colour)) throw new Error(`iconText: no colour ${colour}`);
    const svg = PATHS[shape] ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${PATHS[shape]}</svg>` : '';
    const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
    return `<span class="it it-${colour}"><span class="it-i it-${shape}" ${a11y}>${svg}</span>${text ? `<span class="it-w">${esc(text)}</span>` : ''}</span>`;
  }
  Object.assign(globalThis.BoardUI ||= {}, { iconText, ICON_SHAPES, ICON_COLOURS });
})();
