// The board view's pane: from 900px, Waiting on you (view-questions.js, embedded) beside the lanes, mounted while the
// width lasts (docs/adr/2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md). Every questions URL lands
// here at that width (shell.js go, focusQuestion), and a click on a pill focuses its card on the board
// (docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md). A prototype opens in the pane too, in place of
// Waiting on you until its ‹ Open questions (openViewer). Below 900px there is no pane: the header's ? opens Waiting on
// you as its own page. Needs app-core.js.
BoardView.part((B) => {
  const { $, state } = B;

  // From 900px, the pane beside the lanes, the same width the stylesheet splits the board at.
  const wide = matchMedia('(min-width: 900px)');

  // A fresh board repaints an open viewer's Round pill.
  function renderPane(d) {
    if (viewer) paintViewer(d);
  }

  let questions = null;
  // A click on a pane pill, or on the topic's title, focuses its topic on the board: item:<key> is a card (an ask is one, ask:<id>);
  // any other topic, or one the board doesn't show, does nothing.
  function openOnBoard(id) {
    if (id.startsWith('item:')) B.focusOnBoard({ key: id.slice(5) });
  }
  // What can cover the pane: each closes itself. A new overlay over the pane (the thread's questions modal) joins this list.
  const paneOverlays = [() => B.closeReader?.(), () => closeViewer()];
  // The pane shows its topic: a pill tap or a questions URL (focusQuestion) both land here.
  function showTopic(id) {
    for (const close of paneOverlays) close();
    B.saveFragment({ openItemsCard: id });
  }
  function fitPane() {
    if (wide.matches === Boolean(questions)) return;
    if (questions) { closeViewer(); questions.unmount(); questions.slot.remove(); questions = null; return; }
    $('#boardPane').insertAdjacentHTML('beforeend', `<div class="view-questions pane-questions">${AppViews.questions.markup({ embedded: true })}</div>`);
    const slot = $('#boardPane .pane-questions');
    questions = Object.assign(AppViews.questions.create(slot, B.site.root, { embedded: true, openOnBoard, onTopic: showTopic }), { slot });
    questions.mount();
  }
  // The shell's one rule for a questions URL from 900px (shell.js go): it shows the board and asks here for the question
  // or topic id, or null for none. The pane opens its topic, resolved or not, and focuses its pill → false while there
  // is no pane or it hasn't loaded, so the shell asks again.
  function focusQuestion(id) {
    const topic = (state.board?.ownerTopics || []).find((t) => t.id === id || t.questions.includes(id));
    if (!questions?.B.openTopic(topic?.id ?? id)) return false;
    const pill = questions.slot.querySelector('.topics button[aria-pressed="true"]');
    pill?.focus();
    pill?.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // From 900px a prototype opens in the pane (docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md,
  // shell.js go): a top bar of ‹ Open questions, ⤢ and the card's Round pill over the prototype page framed at the
  // pane's width, which shows its footer at the bottom of the pane (prototype-switcher.js .ps-pane). ⤢ widens the pane
  // over the lanes and back. ‹ returns to Waiting on you with the round's question focused, as Choose this does through
  // the shell. viewer: {url, q, widened, sheet} while one is open. → false while there is no pane, so the shell asks again.
  let viewer = null;
  function openViewer(url) {
    if (!questions) return false;
    viewer = { url, q: new URL(url, location.href).searchParams.get('q'), widened: viewer?.widened ?? false, sheet: false };
    paintViewer();
    return true;
  }
  // board: the board download it shows, which renderPane passes before state.board holds it.
  function paintViewer(board = state.board) {
    const pane = $('#boardPane');
    pane.classList.toggle('viewing', Boolean(viewer));
    pane.classList.toggle('widened', Boolean(viewer?.widened));
    let box = pane.querySelector('.pane-viewer');
    if (!viewer) { box?.remove(); return; }
    if (!box) {
      pane.insertAdjacentHTML('beforeend', '<div class="pane-viewer"><div class="pv-top"></div><iframe class="pv-frame" title="Prototype"></iframe></div>');
      box = pane.querySelector('.pane-viewer');
    }
    const card = (board?.items || []).find((it) => it.prototypes?.rounds?.some((r) => r.q === viewer.q));
    const rounds = card?.prototypes.rounds;
    box.querySelector('.pv-top').innerHTML = `<button type="button" class="pv-back" data-pv="back">‹ Open questions</button><span class="pv-grow"></span>
      <button type="button" class="pv-widen" data-pv="widen" aria-pressed="${viewer.widened}" aria-label="Widen over the lanes" title="Widen over the lanes">⤢</button>${BoardUI.roundPill(rounds, viewer.q)}`;
    box.querySelector('.ps-sheet')?.remove();
    if (viewer.sheet && rounds) box.insertAdjacentHTML('beforeend', BoardUI.roundSheet({ ref: card.ref, rounds, qid: viewer.q }));
    const frame = box.querySelector('iframe.pv-frame');
    if (frame.getAttribute('src') !== viewer.url) frame.setAttribute('src', viewer.url);
  }
  function closeViewer() {
    if (!viewer) return;
    viewer = null;
    paintViewer();
  }
  B.on(B.root, 'click', (ev) => {
    if (!viewer || !ev.target.closest?.('#boardPane .pane-viewer')) return;
    const round = ev.target.closest('[data-ps-round]')?.dataset.psRound;
    if (round) { openViewer(round); return; }
    const act = ev.target.closest('[data-pv], [data-ps-top]');
    if (!act) return;
    if (act.dataset.pv === 'back') { focusQuestion(viewer.q); return; }
    if (act.dataset.pv === 'widen') viewer.widened = !viewer.widened;
    else viewer.sheet = !viewer.sheet;
    paintViewer();
  });
  // A push to a card's thread (#selectedCard=<key>&reply, board/store.mjs threadUrl), the switcher's for a question
  // already picked among them, closes the viewer, so the thread it sent the owner to shows. The older #item=<key>&reply
  // reads the same.
  B.on(window, 'hashchange', () => {
    const at = AppRouter.fragmentOf(location.hash);
    if (at.selectedCard && at.reply) closeViewer();
  });

  fitPane();
  B.on(wide, 'change', fitPane);
  B.atUnmount(() => { questions?.unmount(); questions = null; });

  Object.assign(B, { renderPane, focusQuestion, openViewer });
});
