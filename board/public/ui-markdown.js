// A small Markdown renderer for Notes (view-notes.js; docs/adr/2026-10-29-1639-a-full-plan-opens-as-a-page-on-the-site.md). Needs ui.js and ui-links.js.
(function () {
  const { esc, linkHtml, opensHere } = globalThis.BoardUI;
  // Raw HTML is escaped first, so a link's href can only break out through its scheme.
  const safeUrl = (u) => /^(https?:|mailto:)/i.test(u) || !/^[\w+.-]*:/.test(u);
  const WIDE_CELL = 80;
  const WIDER_CELL = 200;

  function inline(s) {
    return String(s).split(/(`[^`]*`)/).map((part, n) => (n % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => (safeUrl(url) ? `<a href="${url}"${opensHere(url) ? '' : ' target="_blank" rel="noopener"'}>${label}</a>` : m))
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>'))).join('');
  }

  const FENCE = /^\s*```/;
  const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s*>/;
  const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const startsTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
  const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || startsTable(lines, i);

  // A fenced block, with the Copy button the click handler below answers.
  const codeBlock = (body) => `<div class="code-block"><button type="button" class="copy-code" data-copy-code>Copy</button><pre><code>${esc(body.join('\n'))}</code></pre></div>`;
  // The lines after an opening fence at lines[i], up to its closing fence; their indent under the opening fence is dropped.
  function fenceBody(lines, i) {
    const indent = /^\s*/.exec(lines[i])[0].length;
    const body = [];
    for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i].replace(new RegExp(`^\\s{0,${indent}}`), ''));
    return { body, next: i + 1 };
  }

  // links: a ui-links.js linkContext, to link the refs in the plan's text.
  function markdown(src, links = null) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) { i++; continue; }
      if (FENCE.test(line)) {
        const fence = fenceBody(lines, i);
        i = fence.next;
        out.push(codeBlock(fence.body));
      } else if ((m = HEADING.exec(line))) {
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        i++;
      } else if (RULE.test(line)) {
        out.push('<hr>');
        i++;
      } else if (startsTable(lines, i)) {
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
        const cell = (tag, c) => `<${tag}${c.length > WIDER_CELL ? ' class="wider"' : c.length > WIDE_CELL ? ' class="wide"' : ''}>${inline(c)}</${tag}>`;
        out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => cell('th', c)).join('')}</tr></thead>`
          + `<tbody>${rows.map((r) => `<tr>${r.map((c) => cell('td', c)).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else if (QUOTE.test(line)) {
        const body = [];
        for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
      } else if ((m = ITEM.exec(line))) {
        const ordered = /\d/.test(m[2]);
        const base = m[1].length;
        const items = [];
        while (i < lines.length) {
          const it = ITEM.exec(lines[i]);
          if (it && (it[1].length > base || /\d/.test(it[2]) === ordered)) { items.push({ nested: it[1].length > base, text: it[3], blocks: [] }); i++; }
          else if (items.length && /^\s{2,}```/.test(lines[i])) { const fence = fenceBody(lines, i); items[items.length - 1].blocks.push(codeBlock(fence.body)); i = fence.next; }
          else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) { items[items.length - 1].text += ` ${lines[i].trim()}`; i++; }
          else break;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((it) => `<li${it.nested ? ' class="nested"' : ''}>${inline(it.text)}${it.blocks.join('')}</li>`).join('')}</${tag}>`);
      } else {
        const body = [];
        for (; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) body.push(lines[i].trim());
        out.push(`<p>${inline(body.join(' '))}</p>`);
      }
    }
    const html = out.join('\n');
    return links ? linkHtml(html, links) : html;
  }

  // One handler for every page that draws markdown. clipboard needs a secure context; on plain http the block's text is selected to copy by hand.
  globalThis.document?.addEventListener('click', async (ev) => {
    const button = ev.target.closest?.('[data-copy-code]');
    if (!button) return;
    const code = button.parentElement.querySelector('code');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    } catch {
      getSelection().selectAllChildren(code);
    }
  });

  Object.assign(globalThis.BoardUI, { markdown });
})();
