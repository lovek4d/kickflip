// Answering pending prompts from their Needs you lines (ui-prompts.js promptItem), on a board view and the hub page,
// through the hub's POST /_hub/prompts/<id>/answer (docs/adr/2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md).
// Allow once, Deny, Skip and a single question's option send on the tap. Always allow confirms first, naming its rule,
// since it covers every later call like it until the session ends. Several questions, or one taking several picks,
// send with Send once each has a pick.
globalThis.PromptAnswers = (function () {
  // B: the view's recorders. list() → the prompts the view shows; paint() repaints their lines; notify(text) shows a
  // short message; after() runs once an answer has gone. → {state(p) for promptItem, shows(p)}
  function wire(B, { list, paint, notify, after = () => {} }) {
    const picks = new Map();
    const sending = new Set();
    // Answered here, hidden until the view's next load drops them.
    const answered = new Set();
    const picksOf = (id) => { if (!picks.has(id)) picks.set(id, {}); return picks.get(id); };

    async function send(p, body) {
      sending.add(p.id);
      paint();
      try {
        const r = await fetch(`/_hub/prompts/${encodeURIComponent(p.id)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (r.ok || r.status === 404 || r.status === 409) { answered.add(p.id); picks.delete(p.id); }
        if (r.status === 404) notify('That prompt has expired.');
        else if (r.status === 409) notify('That prompt was already answered.');
        else if (!r.ok) notify((await r.json().catch(() => null))?.error || 'Could not send.');
      } catch { notify('Could not send. Is the host awake?'); }
      sending.delete(p.id);
      paint();
      after();
    }

    B.on(B.root, 'click', async (ev) => {
      const li = ev.target.closest?.('li[data-prompt]');
      const p = li && list().find((x) => x.id === li.dataset.prompt);
      if (!p || sending.has(p.id) || answered.has(p.id)) return;
      const opt = ev.target.closest('button[data-prompt-opt]');
      if (opt) {
        const i = Number(opt.dataset.promptQ);
        const q = p.questions[i];
        const mine = picksOf(p.id);
        const got = mine[i] || [];
        const label = opt.dataset.promptOpt;
        mine[i] = q.multiSelect ? (got.includes(label) ? got.filter((l) => l !== label) : [...got, label]) : [label];
        if (BoardUI.oneTap(p)) send(p, BoardUI.promptAnswer(p, mine));
        else paint();
        return;
      }
      if (ev.target.closest('button[data-prompt-send]')) {
        const body = BoardUI.promptAnswer(p, picksOf(p.id));
        if (body) send(p, body);
        return;
      }
      const choice = ev.target.closest('button[data-prompt-choice]')?.dataset.promptChoice;
      if (!choice) return;
      if (choice === 'always' && !(await BoardDialogs.confirm(`Always allow ${p.rule} for the rest of this session?`))) return;
      send(p, { choice });
    });

    return {
      state: (p) => ({ picks: picks.get(p.id) || {}, sending: sending.has(p.id) }),
      shows: (p) => !answered.has(p.id),
    };
  }
  return { wire };
})();
