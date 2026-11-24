// docs/adr/2026-11-24-0030-hovering-a-task-link-shows-its-title.md
// Hovering a task link (ui-links.js taskLink: any <a> to #selectedCard=<key>) with a fine, hovering pointer shows that
// task's title in a one-line popup under the link, after a short delay. It comes from the items the page holds, so a
// task the page doesn't hold shows nothing. It hides when the pointer leaves the link, on scroll and on Escape (popup.js);
// the popup takes no pointer, so the link's click opens the task as ever. Needs popup.js.
BoardView.part((B) => {
  const { state } = B;
  const DELAY = 300;
  const LINK = 'a[href*="#selectedCard="]';
  const tip = document.createElement('div');
  tip.className = 'link-tip';
  tip.setAttribute('role', 'tooltip');
  const text = document.createElement('span');
  tip.appendChild(text);
  let link = null;
  let cancel = () => {};

  const keyOf = (a) => decodeURIComponent(a.getAttribute('href').split('#selectedCard=')[1].split('&')[0]);
  function hide() {
    cancel();
    link = null;
    Popup.close(tip);
  }
  function show(a) {
    const title = (state.board?.items || []).find((i) => i.key === keyOf(a))?.title;
    if (!title || link !== a) return;
    text.textContent = title;
    tip.removeAttribute('hidden');
    Popup.open(tip, a, { onClose: hide });
  }

  B.on(B.root, 'pointerover', (ev) => {
    const a = ev.target.closest(LINK);
    if (!a || a === link || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    hide();
    link = a;
    cancel = B.later(DELAY, () => show(a));
  });
  B.on(B.root, 'pointerout', (ev) => { if (link && ev.target.closest(LINK) === link && !link.contains(ev.relatedTarget)) hide(); });
  B.on(window, 'scroll', () => { if (link) hide(); }, { capture: true, passive: true });
  B.atUnmount(hide);
});
