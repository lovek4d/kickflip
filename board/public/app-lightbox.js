// docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md
// The image viewer: a tap on an image's thumbnail (ui.js attachments, in the New strip or a thread) opens it full size
// over the board in #lightbox (app.js), named, with ‹ and › and the arrow keys stepping through the images of the same
// message. ✕, the dim area, a swipe down or Escape closes it. A click with a modifier key, or a middle click, opens the
// file as the link it is.
BoardView.part((B) => {
  const { $ } = B;
  const box = $('#lightbox');
  const img = box.querySelector('img');
  let set = [];
  let at = 0;

  function show(i) {
    at = (i + set.length) % set.length;
    const a = set[at];
    img.setAttribute('src', a.getAttribute('href'));
    img.setAttribute('alt', a.getAttribute('title'));
    box.querySelector('.lightbox-name').textContent = a.getAttribute('title');
    box.querySelector('.lightbox-at').textContent = `${at + 1} of ${set.length}`;
    box.querySelector('.lightbox-nav').hidden = set.length < 2;
  }
  B.on(B.root, 'click', (ev) => {
    const thumb = ev.target.closest('a.file-thumb');
    if (thumb) {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button > 0) return;
      ev.preventDefault();
      set = [...thumb.closest('.files').querySelectorAll('a.file-thumb')];
      show(set.indexOf(thumb));
      if (!box.open) box.showModal();
      return;
    }
    const step = ev.target.closest('[data-lightbox]')?.dataset.lightbox;
    if (step === 'close' || BoardUI.onBackdrop(ev, box)) box.close();
    else if (step) show(at + (step === 'next' ? 1 : -1));
  });
  B.atUnmount(BoardUI.swipeToDismiss(box));
  B.on(box, 'keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    show(at + (ev.key === 'ArrowRight' ? 1 : -1));
  });
});
