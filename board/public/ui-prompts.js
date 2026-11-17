// A pending prompt's Needs you line (hub/prompts.mjs shown): a permission prompt with Allow once, Always allow and
// Deny, or an AskUserQuestion with its options as buttons and Skip, and Send when it takes more than one tap.
(function () {
  const { esc, ago } = globalThis.BoardUI;

  // The answer a question prompt's picks make, {choice: 'allow', answers: {<question>: <label, or labels joined by
  // ", ">}}, or null until every question has a pick. picks: {<question index>: [label]}.
  function promptAnswer(p, picks = {}) {
    const answers = Object.create(null);
    for (const [i, q] of (p.questions || []).entries()) {
      const got = picks[i] || [];
      if (!got.length) return null;
      answers[q.question] = got.join(', ');
    }
    return { choice: 'allow', answers };
  }

  // Whether one tap on an option answers: a single question that takes one pick.
  const oneTap = (p) => p.questions?.length === 1 && !p.questions[0].multiSelect;

  // sending: while the answer goes, the tapped button: a choice ('allow', 'always', 'deny'), 'send', or an option as
  // '<question index>:<label>'. It waits (ui.js BUSY) and the line's other buttons are disabled.
  function promptItem(p, { picks = {}, sending = null } = {}) {
    const off = (tapped) => (sending === null ? '' : sending === tapped ? BoardUI.BUSY : ' disabled');
    const where = [ago(p.at), p.cwd].filter(Boolean).map(esc).join(' · ');
    const head = `<div class="prompt-head"><b>${esc(p.questions ? 'Question' : p.tool)}</b><span class="muted small">${where}</span></div>`;
    if (p.questions) {
      const questions = p.questions.map((q, i) => `<div class="prompt-q"><p>${q.header ? `<span class="chip">${esc(q.header)}</span> ` : ''}${esc(q.question)}</p>
<div class="prompt-options" role="group" aria-label="${esc(q.question)}">${q.options.map((o) => `<button type="button" data-prompt-q="${i}" data-prompt-opt="${esc(o.label)}" aria-pressed="${(picks[i] || []).includes(o.label)}"${off(`${i}:${o.label}`)}><span class="lbl">${esc(o.label)}</span>${o.description ? `<span class="det">${esc(o.description)}</span>` : ''}</button>`).join('')}</div></div>`).join('');
      const send = oneTap(p) ? '' : `<button type="button" class="primary" data-prompt-send${off('send') || (promptAnswer(p, picks) ? '' : ' disabled')}>Send</button>`;
      return `<li class="prompt" data-prompt="${esc(p.id)}">${head}${questions}<div class="prompt-actions">${send}<button type="button" class="deny" data-prompt-choice="deny"${off('deny')}>Skip</button></div></li>`;
    }
    const detail = p.detail ? `<pre class="prompt-detail">${esc(p.detail)}</pre>` : `<p class="prompt-what">Wants to ${esc(p.action)}</p>`;
    const rule = p.rule ? `<p class="muted small prompt-rule">Always allow adds <code>${esc(p.rule)}</code> until the session ends.</p>` : '';
    return `<li class="prompt" data-prompt="${esc(p.id)}">${head}${detail}<div class="prompt-actions"><button type="button" class="primary" data-prompt-choice="allow"${off('allow')}>Allow once</button><button type="button" data-prompt-choice="always"${off('always')}>Always allow</button><button type="button" class="deny" data-prompt-choice="deny"${off('deny')}>Deny</button></div>${rule}</li>`;
  }

  // docs/adr/2026-11-16-1930-a-joined-boards-prompts-show-on-the-board.md
  // A joined board's prompt strip, right under the pause banner and drawn as its red banner (ui-hub.js pauseBanner), one
  // row a pending permission prompt of the board's session (hub/prompts.mjs shown): "Orchestrator waits on you ·
  // <tool>: <what>" with Allow once, Always and Deny. A board session's questions never come here: the ask gate
  // (hooks-plugin/hooks/ask-gate.mjs) sends them to the board as questions. The taps are prompts.js's. state(p) is
  // prompts.js's {sending}; answered(p) marks a row answered here, which fades out, its buttons disabled, until the
  // board's next copy drops it.
  const ALERT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
  function promptStrip(prompts, { state = () => ({}), answered = () => false } = {}) {
    if (!prompts.length) return '';
    return `<ul class="prompt-strip">${prompts.map((p) => stripRow(p, state(p), answered(p))).join('')}</ul>`;
  }
  function stripRow(p, { sending = null }, done) {
    const off = (tapped) => (done ? ' disabled' : sending === null ? '' : sending === tapped ? BoardUI.BUSY : ' disabled');
    const button = (cls, choice, label) => `<button type="button" class="btn ${cls}" data-prompt-choice="${choice}"${off(choice)}>${label}</button>`;
    return `<li class="hold-banner ub-banner ub-going prompt-row${done ? ' prompt-answered' : ''}" data-prompt="${esc(p.id)}" role="alert">${ALERT}`
      + `<span class="prompt-what"><b>Orchestrator waits on you</b> · ${esc(p.tool)}: <code>${esc(p.detail || p.action)}</code></span>`
      + `<span class="prompt-actions">${button('primary', 'allow', 'Allow once')}${button('quiet', 'always', 'Always')}${button('quiet deny', 'deny', 'Deny')}</span></li>`;
  }

  Object.assign(globalThis.BoardUI, { promptItem, promptAnswer, oneTap, promptStrip });
})();
