// The board view's Needs you (domain.mjs needsOf), led by the board session's pending prompts, answered in place
// (prompts.js). It draws twice, and the stylesheet shows one by width
// (docs/adr/2026-11-05-0408-needs-you-is-a-deck-on-a-phone-and-a-pane-on-a-desktop.md):
// - on a phone, #needsDeck at the top of the board: one thing at a time, a question's option marked on the first tap,
//   turning into Send “<label>”, and sent with the question's drafted note and files on a tap on it
//   (docs/adr/2026-11-07-1212-a-deck-option-sends-on-a-second-tap.md), a prompt's buttons answering it, Prev and Next
//   beside a dot for each thing waiting, and All open questions at its foot;
// - from 900px, #waiting, one line each, in the pane beside the lanes, over Waiting on you mounted there
//   (view-questions.js, embedded) while the width lasts. Waiting on you shows the questions there, so #waiting leaves out
//   a line that only asks questions, and with nothing else left the orange section is gone. Every questions URL lands
//   here at that width (shell.js go, focusQuestion), and two taps on a pill focus its card on the board
//   (docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md). A prototype opens in the pane too, in place of
//   Waiting on you until its ‹ Open questions (openViewer).
// Below 900px the header's ? opens Waiting on you, with the open-question count as its badge.
// Needs app-core.js.
BoardView.part((B) => {
  const { $, plural, state, toast } = B;
  const { esc, escText, promptItem, choiceLabel, isPrototype, getDraft, setDraft, noteOf, waitOn } = BoardUI;

  const prompts = PromptAnswers.wire(B, {
    list: () => (state.board?.needs || []).filter((line) => line.prompt).map((line) => line.prompt),
    paint: () => { if (state.board) renderNeeds(state.board); },
    notify: (text) => toast(text),
    after: () => B.loadBoard(),
  });

  // From 900px, the pane beside the lanes, the same width the stylesheet splits the board at.
  const wide = matchMedia('(min-width: 900px)');

  function renderNeeds(d) {
    const needs = (d.needs || []).filter((line) => !line.prompt || prompts.shows(line.prompt));
    renderList(wide.matches ? needs.filter((line) => !line.questions || line.ready || line.action) : needs);
    renderDeck(d, needs);
    renderAsk(d);
    if (viewer) paintViewer(d);
  }

  // The header's ? below 900px, which opens Waiting on you, carries the open-question count as its badge.
  function renderAsk(d) {
    const open = (d.owner || []).filter((q) => q.state === 'open').length;
    const ask = $('#questionsLink');
    const badge = ask.querySelector('.q-badge');
    badge.hidden = !open;
    badge.textContent = open ? String(open) : '';
    ask.setAttribute('aria-label', open ? `Open questions, ${open} open` : 'Open questions');
  }

  function renderList(needs) {
    const parts = (line) => [
      line.questions ? `<a href="${esc(line.questions.url)}">${plural(line.questions.open, 'question')}</a>` : '',
      line.ready ? `<a href="${esc(line.ready)}" target="_blank" rel="noopener">Ready on GitHub</a>` : '',
      line.action ? `<a href="${esc(line.action.url)}">${escText(line.action.label)}</a>` : '',
    ].filter(Boolean).join(' · ');
    const w = $('#waiting');
    w.hidden = needs.length === 0;
    w.innerHTML = needs.length ? `<h2 style="margin:0 0 6px">Needs you · ${needs.length}</h2>
      <ul>${needs.map((line) => (line.prompt ? promptItem(line.prompt, prompts.state(line.prompt))
        : line.key ? `<li><a href="${esc(line.url)}">${escText(line.title)}</a> <span class="muted small">· ${parts(line)}</span></li>`
          : line.review ? `<li><a href="${esc(line.url)}" data-review-open="${line.review}">${escText(line.title)}</a> <span class="muted small">· review held for you</span></li>`
          : line.band ? `<li><a href="#" data-band-show="${esc(line.band)}">${escText(line.title)}</a> <span class="muted small">· ${parts(line)}</span></li>`
          : `<li><a href="${esc(line.url)}">${escText(line.title)}</a> <span class="muted small">${plural(line.questions.open, 'question')}</span></li>`)).join('')}</ul>` : '';
  }

  // The deck's things, in Needs you order: a prompt; each open question of a line that asks some, in its topic's
  // order; any other line as itself. → [{id, what, html}]
  function deckOf(d, needs) {
    const items = d.items || [];
    const owner = (d.owner || []).filter((q) => q.state === 'open');
    const topicOf = (line) => line.topic || items.find((it) => it.key === line.key)?.questions?.topic || null;
    return needs.flatMap((line) => {
      if (line.prompt) return [{ id: `p:${line.prompt.id}`, what: 'Claude asks', html: `<ul class="deck-prompt">${promptItem(line.prompt, prompts.state(line.prompt))}</ul>` }];
      const what = line.key ? line.title.split(':')[0] : line.title;
      const topic = line.questions && topicOf(line);
      const order = (d.ownerTopics || []).find((t) => t.id === topic)?.questions || [];
      const asks = topic ? owner.filter((q) => q.topic === topic).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : [];
      if (asks.length) return asks.map((q) => ({ id: `q:${q.id}`, what, html: questionHtml(q) }));
      const [label, href, attrs] = line.questions ? [`Answer ${plural(line.questions.open, 'question')}`, line.questions.url, '']
        : line.ready ? ['Ready on GitHub', line.ready, ' target="_blank" rel="noopener"']
        : line.action ? [line.action.label, line.action.url, '']
        : line.review ? ['Open the review', line.url, ` data-review-open="${line.review}"`]
        : ['Open', line.url, ''];
      const title = line.key ? line.title.slice(what.length + 1).trim() : line.title;
      return [{ id: `l:${line.key || line.review || line.band || line.url}`, what,
        html: `<h3>${line.key ? `<a href="${esc(line.url)}">${escText(title)}</a>` : escText(title)}</h3>${line.review ? '<p class="ctx">review held for you</p>' : ''}<div class="deck-acts"><a class="button primary" href="${esc(href)}"${attrs}>${esc(label)}</a></div>` }];
    });
  }
  // The marked option, the question's drafted pick, reads Send “<label>”.
  const questionHtml = (q) => {
    const marked = getDraft(q.id).choice;
    const optionHtml = (o) => {
      const armed = o.id === marked;
      const label = armed ? `Send “${esc(o.label)}”` : `${esc(choiceLabel(q, o.id))}${o.recommended ? ' <span class="rec-word">recommended</span>' : ''}`;
      return `<button type="button" class="${[o.recommended && 'rec', armed && 'armed'].filter(Boolean).join(' ')}" aria-pressed="${armed}" data-deck-pick="${esc(o.id)}"><span class="lbl">${label}</span>${o.detail ? `<small>${escText(o.detail)}</small>` : ''}</button>`;
    };
    return `<h3>${escText(q.question)}</h3>${q.context ? `<p class="ctx">${escText(q.context)}</p>` : ''}
    ${isPrototype(q.url) ? `<a class="button deck-proto" href="${esc(q.url)}">View prototypes</a>` : ''}
    <div class="deck-opts" role="group" aria-label="${esc(q.question)}">${q.options.map(optionHtml).join('')}</div>`;
  };

  // The thing on screen, by id, so an arrival or a repaint keeps it; once it is gone the deck shows what took its place.
  let showing = null;
  let deck = [];
  function renderDeck(d, needs) {
    const el = $('#needsDeck');
    const before = deck.findIndex((x) => x.id === showing);
    deck = deckOf(d, needs);
    el.hidden = deck.length === 0;
    if (!deck.length) { el.innerHTML = ''; showing = null; return; }
    const now = deck.find((x) => x.id === showing) || deck[Math.min(Math.max(before, 0), deck.length - 1)];
    showing = now.id;
    const at = deck.indexOf(now);
    const open = (d.owner || []).filter((q) => q.state === 'open').length;
    const drafted = (d.owner || []).filter((q) => q.state === 'open' && 'choice' in getDraft(q.id)).length;
    BoardUI.setHTML(el, `<div class="deck-head"><h2>Needs you</h2><span class="deck-n">${deck.length}</span></div>
      <div class="deck-card" data-deck="${esc(now.id)}"><p class="deck-what">${escText(now.what)}</p>${now.html}</div>
      ${deck.length > 1 ? `<div class="deck-bar"><button type="button" class="ghost" data-deck-prev${at === 0 ? ' disabled' : ''}>← Prev</button><span class="deck-dots" aria-hidden="true">${deck.map((x) => `<i${x === now ? ' class="on"' : ''}></i>`).join('')}</span><button type="button" class="ghost" data-deck-next${at === deck.length - 1 ? ' disabled' : ''}>Next →</button></div>` : ''}
      ${open ? `<a class="deck-more" href="questions.html">All open questions · ${open}${drafted ? ` · ${drafted} drafted, Send there` : ''}</a>` : ''}`);
  }

  // The deck's index one step from the thing on screen; the ends hold.
  const stepFrom = (step) => Math.min(Math.max(deck.findIndex((x) => x.id === showing) + step, 0), deck.length - 1);
  B.on(B.root, 'click', (ev) => {
    if (!ev.target.closest?.('#needsDeck')) return;
    const step = ev.target.closest('[data-deck-prev]') ? -1 : ev.target.closest('[data-deck-next]') ? 1 : 0;
    if (step) {
      showing = deck[stepFrom(step)].id;
      renderNeeds(state.board);
      return;
    }
    const opt = ev.target.closest('button[data-deck-pick]');
    if (!opt) return;
    const id = opt.closest('[data-deck]').dataset.deck.slice(2);
    const choice = opt.dataset.deckPick;
    const draft = getDraft(id);
    if (draft.choice !== choice) {
      setDraft(id, { ...draft, choice });
      renderNeeds(state.board);
      return;
    }
    sendAnswer((state.board.owner || []).find((q) => q.id === id), choice, opt);
  });

  // The marked option's tap sends it with the question's drafted note and files, as the questions page's Send does, and
  // spins until the board shows the question answered, which takes it off the deck. Files still uploading hold it.
  async function sendAnswer(q, choice, button) {
    const composer = 'q:' + q.id;
    if (BoardAttach.busy(composer, B.site.root)) { toast('Wait for the upload to finish'); return; }
    const files = BoardAttach.files(composer, B.site.root);
    const answer = { id: q.id, question: q.question, choice, label: choiceLabel(q, choice), note: noteOf(q, getDraft(q.id)).trim(), ...(files.length ? { files } : {}) };
    const sent = () => { setDraft(q.id, {}); BoardAttach.clear(composer, B.site.root); };
    try {
      await waitOn(button, BoardUI.pending.within(B.send('owner-answers', { answers: [answer] }, sent), B.stillWaiting));
    } catch (e) { B.failed(e); }
  }

  // From 900px, Waiting on you in the pane under the Needs you lines, mounted while the width lasts.
  let questions = null;
  // Two taps on a pane pill focus its topic on the board: item:<key> is a card (an ask is one, ask:<id>),
  // wave:<slug> a band; any other topic, or one the board doesn't show, does nothing.
  function openOnBoard(id) {
    if (id.startsWith('item:')) B.focusOnBoard({ key: id.slice(5) });
    else if (id.startsWith('wave:')) B.focusOnBoard({ slug: id.slice(5) });
  }
  function fitPane() {
    if (wide.matches === Boolean(questions)) return;
    if (state.board) renderNeeds(state.board);
    if (questions) { closeViewer(); questions.unmount(); questions.slot.remove(); questions = null; return; }
    $('#needsPane').insertAdjacentHTML('beforeend', `<div class="view-questions needs-questions">${AppViews.questions.markup({ embedded: true })}</div>`);
    const slot = $('#needsPane .needs-questions');
    questions = Object.assign(AppViews.questions.create(slot, B.site.root, { embedded: true, openOnBoard }), { slot });
    questions.mount();
  }
  // The shell's one rule for a questions URL from 900px (shell.js go): it shows the board and asks here for the question
  // or topic id, or null for none. The pane opens its topic, resolved or not, and focuses its pill → false while there
  // is no pane or it hasn't loaded, so the shell asks again.
  function focusQuestion(id) {
    closeViewer();
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
  // board: the board download it shows, which renderNeeds passes before state.board holds it.
  function paintViewer(board = state.board) {
    const pane = $('#needsPane');
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
    if (!viewer || !ev.target.closest?.('#needsPane .pane-viewer')) return;
    const round = ev.target.closest('[data-ps-round]')?.dataset.psRound;
    if (round) { openViewer(round); return; }
    const act = ev.target.closest('[data-pv], [data-ps-top]');
    if (!act) return;
    if (act.dataset.pv === 'back') { focusQuestion(viewer.q); return; }
    if (act.dataset.pv === 'widen') viewer.widened = !viewer.widened;
    else viewer.sheet = !viewer.sheet;
    paintViewer();
  });
  // A push to a card's thread (#item=<key>&reply, board/store.mjs pushUrl), the switcher's for a question already picked
  // among them, closes the viewer, so the thread it sent the owner to shows.
  B.on(window, 'hashchange', () => { if (/^#item=[^&]+&reply$/.test(location.hash)) closeViewer(); });

  fitPane();
  B.on(wide, 'change', fitPane);
  B.atUnmount(() => { questions?.unmount(); questions = null; });

  Object.assign(B, { renderNeeds, focusQuestion, openViewer });
});
