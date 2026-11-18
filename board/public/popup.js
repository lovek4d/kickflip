// Popup: every popup on the board and the hub opens through here
// (docs/adr/2026-11-18-0300-every-popup-opens-through-one-seam.md): the board filter's checklist, a card's menu, the
// board menu, Main's failed-pull reason and Hub › Slack's emoji grid. Its owner draws it and says when it opens;
// Popup.open(el, anchor, {align, onClose}) shows it beside the button that opened it, and Popup.close(el) hides it.
// - It shows as a manual popover, in the browser's top layer, so it draws above every sheet and modal open under it
//   with no z-index.
// - It sits under its anchor, or above it when it doesn't fit below and there is more room above. Its left edge lines
//   up with the anchor's, or with align 'end' its right edge. Then it is kept inside the visible screen
//   (window.visualViewport, less an 8px margin or the safe-area inset, whichever is larger) on both axes, its
//   max-height the room it has, scrolling past it.
// - It places again on a resize of the window or the visual viewport, a scroll of the visual viewport and any change to
//   the page while it is open.
// - A tap outside it and its anchor, or Escape, closes it and only it: the Escape doesn't reach a sheet under it. So
//   does its anchor leaving the page. Each then calls the owner's onClose(escaped), which draws the page without it.
// One popup is open at a time: opening another closes the first without its onClose. An owner redrawing the popup
// opens the new element again; once the open element has left the page, the popup is closed.
(function () {
  const GAP = 4;
  let open = null;

  // The room the popup may use: the visual viewport in the layout viewport's coordinates, less each side's margin.
  // .popup's scroll-margin is max(8px, that side's safe-area inset) (style.css), which reads back here in px.
  function screenBox(el) {
    const s = getComputedStyle(el);
    const v = visualViewport;
    return {
      left: v.offsetLeft + parseFloat(s.scrollMarginLeft),
      right: v.offsetLeft + v.width - parseFloat(s.scrollMarginRight),
      top: v.offsetTop + parseFloat(s.scrollMarginTop),
      bottom: v.offsetTop + v.height - parseFloat(s.scrollMarginBottom),
    };
  }
  function place() {
    const { el, anchor, align } = open;
    const box = screenBox(el);
    el.style.maxHeight = 'none';
    el.style.maxWidth = `${box.right - box.left}px`;
    const a = anchor.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const below = box.bottom - a.bottom - GAP;
    const above = a.top - GAP - box.top;
    const down = height <= below || below >= above;
    const shown = Math.min(height, box.bottom - box.top, Math.max(down ? below : above, 0));
    el.style.maxHeight = `${shown}px`;
    const top = down ? a.bottom + GAP : a.top - GAP - shown;
    const left = align === 'end' ? a.right - width : a.left;
    el.style.top = `${Math.max(box.top, Math.min(top, box.bottom - shown))}px`;
    el.style.left = `${Math.max(box.left, Math.min(left, box.right - width))}px`;
  }

  // The page changed: a popup whose element left closed with its owner's redraw; one whose anchor left closes.
  function changed() {
    if (!open.el.isConnected) stop();
    else if (!open.anchor.isConnected) dismiss(false);
    else place();
  }
  function onClick(ev) {
    if (!open.el.contains(ev.target) && !open.anchor.contains(ev.target)) dismiss(false);
  }
  function onKey(ev) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    dismiss(true);
  }
  const listeners = () => [[window, 'resize', place], [visualViewport, 'resize', place], [visualViewport, 'scroll', place],
    [document, 'click', onClick, true], [document, 'keydown', onKey, true]];

  function stop() {
    for (const [target, type, fn, capture] of listeners()) target.removeEventListener(type, fn, capture);
    open.observer.disconnect();
    if (open.el.isConnected) open.el.hidePopover();
    open = null;
  }
  // Closed by the seam: the owner hears it, and whether it was Escape, after which an owner may focus its button again.
  function dismiss(escaped) {
    const { onClose } = open;
    stop();
    onClose?.(escaped);
  }

  // Shows el beside anchor, or places it again when it is the one open (a repaint of the same element).
  function show(el, anchor, { align = 'start', onClose = null } = {}) {
    if (open && open.el !== el) stop();
    // An owner's in-place redraw (ui.js setHTML) patches the open element back to its markup, dropping the class and
    // the popover attribute, so each call sets them again and shows the element if it no longer is.
    // Without its popover attribute an element is no popover and not open.
    const kept = open?.el === el && el.getAttribute('popover') === 'manual';
    el.classList.add('popup');
    el.setAttribute('popover', 'manual');
    if (!kept) el.showPopover();
    if (!open) {
      const observer = new MutationObserver(changed);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      open = { el, observer };
      for (const [target, type, fn, capture] of listeners()) target.addEventListener(type, fn, capture);
    }
    Object.assign(open, { anchor, align, onClose });
    place();
  }
  // The owner closes el itself: its onClose isn't called.
  function close(el) {
    if (open?.el === el) stop();
  }

  globalThis.Popup = { open: show, close };
})();
