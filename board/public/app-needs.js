// The board view's Needs you (domain.mjs needsOf), led by the board session's pending prompts, answered in place
// (prompts.js). It draws twice, and the stylesheet shows one by width
// (docs/adr/2026-11-05-0408-needs-you-is-a-deck-on-a-phone-and-a-pane-on-a-desktop.md):
// - on a phone, #needsDeck at the top of the board: one thing at a time, a question's options and a prompt's buttons
//   answering it on the tap, Skip to the next, a dot for each thing waiting, and All open questions at its foot;
// - from 900px, #waiting, one line each, in the pane beside the lanes, over Waiting on you mounted there
//   (view-questions.js, embedded) while the width lasts.
// Needs app-core.js.
BoardView.part((B) => {
  const { $, plural, state, toast } = B;
  const { esc, promptItem, choiceLabel, isPrototype } = BoardUI;

  const prompts = PromptAnswers.wire(B, {
    list: () => (state.board?.needs || []).filter((line) => line.prompt).map((line) => line.prompt),
    paint: () => { if (state.board) renderNeeds(state.board); },
    notify: (text) => toast(text),
    after: () => B.loadBoard(),
  });

  function renderNeeds(d) {
    const needs = (d.needs || []).filter((line) => !line.prompt || prompts.shows(line.prompt));
    renderList(needs);
    renderDeck(d, needs);
  }

  function renderList(needs) {
    const parts = (line) => [
      line.questions ? `<a href="${esc(line.questions.url)}">${plural(line.questions.open, 'question')}</a>` : '',
      line.ready ? `<a href="${esc(line.ready)}" target="_blank" rel="noopener">Ready on GitHub</a>` : '',
      line.action ? `<a href="${esc(line.action.url)}">${esc(line.action.label)}</a>` : '',
    ].filter(Boolean).join(' · ');
    const w = $('#waiting');
    w.hidden = needs.length === 0;
    w.innerHTML = needs.length ? `<h2 style="margin:0 0 6px">Needs you · ${needs.length}</h2>
      <ul>${needs.map((line) => (line.prompt ? promptItem(line.prompt, prompts.state(line.prompt))
        : line.key ? `<li><a href="${esc(line.url)}">${esc(line.title)}</a> <span class="muted small">· ${parts(line)}</span></li>`
          : line.review ? `<li><a href="${esc(line.url)}" data-review-open="${line.review}">${esc(line.title)}</a> <span class="muted small">· review held for you</span></li>`
          : line.band ? `<li><a href="#" data-band-show="${esc(line.band)}">${esc(line.title)}</a> <span class="muted small">· ${parts(line)}</span></li>`
          : `<li><a href="${esc(line.url)}">${esc(line.title)}</a> <span class="muted small">${plural(line.questions.open, 'question')}</span></li>`)).join('')}</ul>` : '';
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
        html: `<h3>${line.key ? `<a href="${esc(line.url)}">${esc(title)}</a>` : esc(title)}</h3>${line.review ? '<p class="ctx">review held for you</p>' : ''}<div class="deck-acts"><a class="button primary" href="${esc(href)}"${attrs}>${esc(label)}</a></div>` }];
    });
  }
  const questionHtml = (q) => `<h3>${esc(q.question)}</h3>${q.context ? `<p class="ctx">${esc(q.context)}</p>` : ''}
    ${isPrototype(q.url) ? `<a class="button deck-proto" href="${esc(q.url)}">View prototypes</a>` : ''}
    <div class="deck-opts" role="group" aria-label="${esc(q.question)}">${q.options.map((o) => `<button type="button" class="${o.recommended ? 'rec' : ''}" data-deck-pick="${esc(o.id)}"><span class="lbl">${esc(choiceLabel(q, o.id))}${o.recommended ? ' <span class="rec-word">recommended</span>' : ''}</span>${o.detail ? `<small>${esc(o.detail)}</small>` : ''}</button>`).join('')}</div>`;

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
    const open = (d.owner || []).filter((q) => q.state === 'open').length;
    BoardUI.setHTML(el, `<div class="deck-head"><h2>Needs you</h2><span class="deck-n">${deck.length}</span></div>
      <div class="deck-card" data-deck="${esc(now.id)}"><p class="deck-what">${esc(now.what)}</p>${now.html}</div>
      ${deck.length > 1 ? `<div class="deck-bar"><span class="deck-dots" aria-hidden="true">${deck.map((x) => `<i${x === now ? ' class="on"' : ''}></i>`).join('')}</span><button type="button" class="ghost" data-deck-skip>Skip →</button></div>` : ''}
      ${open ? `<a class="deck-more" href="questions.html">All open questions · ${open}</a>` : ''}`);
  }

  B.on(B.root, 'click', async (ev) => {
    if (!ev.target.closest?.('#needsDeck')) return;
    if (ev.target.closest('[data-deck-skip]')) {
      const at = deck.findIndex((x) => x.id === showing);
      showing = deck[(at + 1) % deck.length].id;
      renderNeeds(state.board);
      return;
    }
    const opt = ev.target.closest('button[data-deck-pick]');
    if (!opt) return;
    const id = opt.closest('[data-deck]').dataset.deck.slice(2);
    const q = state.board.owner.find((x) => x.id === id);
    const choice = opt.dataset.deckPick;
    const answer = { id: q.id, question: q.question, choice, label: choiceLabel(q, choice), note: '' };
    try { await BoardUI.waitOn(opt, B.send('owner-answers', { answers: [answer] }), { group: [...opt.parentNode.querySelectorAll('button')] }); }
    catch (e) { B.failed(e); }
  });

  // From 900px, Waiting on you in the pane under the Needs you lines, mounted while the width lasts.
  const wide = matchMedia('(min-width: 900px)');
  let questions = null;
  function fitPane() {
    if (wide.matches === Boolean(questions)) return;
    if (questions) { questions.unmount(); questions.slot.remove(); questions = null; return; }
    $('#needsPane').insertAdjacentHTML('beforeend', `<div class="view-questions needs-questions">${AppViews.questions.markup({ embedded: true })}</div>`);
    const slot = $('#needsPane .needs-questions');
    questions = Object.assign(AppViews.questions.create(slot, B.site.root, { embedded: true }), { slot });
    questions.mount();
  }
  fitPane();
  B.on(wide, 'change', fitPane);
  B.atUnmount(() => { questions?.unmount(); questions = null; });

  Object.assign(B, { renderNeeds });
});
