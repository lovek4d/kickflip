const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['textarea', 'script', 'style']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] !== '#' ? ENT[e.toLowerCase()] ?? m
  : String.fromCodePoint(/x/i.test(e[1]) ? parseInt(e.slice(2), 16) : Number(e.slice(1)))));
const escText = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const escAttr = (s) => s.replace(/[&"]/g, (c) => ({ '&': '&amp;', '"': '&quot;' })[c]);
const dataAttr = (k) => `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const TOKEN = /<!--([\s\S]*?)-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+|<)/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const SIMPLE = /\*|[\w-]+|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([\^$*~]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:scope|:not\(((?:[^()]|\([^()]*\))*)\)/y;

function splitTop(s, at) {
  const out = [];
  let depth = 0;
  let q = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && at(c)) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

function compound(src) {
  const tests = [];
  const re = new RegExp(SIMPLE.source, 'y');
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m || m.index !== at) throw new Error(`selector not supported: ${src}`);
    const [all, id, cls, attr, op, v1, v2, v3, not] = m;
    const value = v1 ?? v2 ?? v3;
    if (all === '*') tests.push(() => true);
    else if (all === ':scope') tests.push((el, scope) => el === scope);
    else if (id) tests.push((el) => el.getAttribute('id') === id);
    else if (cls) tests.push((el) => el.classList.contains(cls));
    else if (attr) {
      tests.push((el) => {
        const a = el.getAttribute(attr);
        if (a == null) return false;
        if (!op) return true;
        return { '=': a === value, '^=': a.startsWith(value), '$=': a.endsWith(value), '*=': a.includes(value), '~=': a.split(/\s+/).includes(value) }[op];
      });
    } else if (not !== undefined) { const inner = parse(not); tests.push((el, scope) => !matchList(el, inner, scope)); }
    else tests.push((el) => el.tagName === all.toUpperCase());
  }
  return (el, scope) => tests.every((t) => t(el, scope));
}

function complex(src) {
  const parts = [];
  let comb = null;
  for (const tok of splitTop(src.replace(/>/g, ' > '), (c) => /\s/.test(c)).filter(Boolean)) {
    if (tok === '>') { comb = '>'; continue; }
    parts.push({ comb: parts.length ? comb || ' ' : null, test: compound(tok) });
    comb = null;
  }
  return parts;
}

const cache = new Map();
function parse(sel) {
  if (!cache.has(sel)) cache.set(sel, splitTop(sel, (c) => c === ',').map(complex));
  return cache.get(sel);
}

function matchParts(el, parts, scope, k = parts.length - 1) {
  if (!parts[k].test(el, scope)) return false;
  if (k === 0) return true;
  if (parts[k].comb === '>') return el.parentNode?.nodeType === 1 && matchParts(el.parentNode, parts, scope, k - 1);
  for (let p = el.parentNode; p?.nodeType === 1; p = p.parentNode) if (matchParts(p, parts, scope, k - 1)) return true;
  return false;
}
const matchList = (el, list, scope) => list.some((parts) => matchParts(el, parts, scope));

export function miniDom(Target, document) {
  class Node extends Target {
    constructor() { super(); this.parentNode = null; this.childNodes = []; }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes.at(-1) ?? null; }
    get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
    get previousSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] ?? null : null; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    get firstElementChild() { return this.children[0] ?? null; }
    get previousElementSibling() { let n = this.previousSibling; while (n && n.nodeType !== 1) n = n.previousSibling; return n; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document.body; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); if (v != null && v !== '') this.appendChild(new Text(String(v))); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    insertBefore(n, ref) {
      if (n.nodeType === 11) { for (const c of [...n.childNodes]) this.insertBefore(c, ref); return n; }
      n.parentNode?.removeChild(n);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
      n.parentNode = this;
      return n;
    }
    appendChild(n) { return this.insertBefore(n, null); }
    removeChild(n) {
      if (document.activeElement && n.contains(document.activeElement)) document.activeElement = null;
      this.childNodes.splice(this.childNodes.indexOf(n), 1);
      n.parentNode = null;
      return n;
    }
    remove() { this.parentNode?.removeChild(this); }
    before(n) { this.parentNode.insertBefore(n, this); }
    replaceWith(n) { const p = this.parentNode; p.insertBefore(n, this); p.removeChild(this); }
    replaceChildren() { for (const c of [...this.childNodes]) this.removeChild(c); }
    querySelectorAll(sel) {
      const list = parse(sel);
      const out = [];
      const walk = (p) => { for (const c of p.children) { if (matchList(c, list, this)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  }
  class Text extends Node {
    constructor(v) { super(); this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = v; }
    get textContent() { return this.nodeValue; }
    set textContent(v) { this.nodeValue = String(v); }
  }
  class Comment extends Text {
    constructor(v) { super(v); this.nodeType = 8; this.nodeName = '#comment'; }
    get textContent() { return ''; }
  }
  class Fragment extends Node {
    constructor() { super(); this.nodeType = 11; this.nodeName = '#document-fragment'; }
  }
  const raw = (n) => ['SCRIPT', 'STYLE'].includes(n.parentNode?.tagName);
  const serialize = (n) => (n.nodeType === 3 ? (raw(n) ? n.nodeValue : escText(n.nodeValue)) : n.nodeType === 8 ? `<!--${n.nodeValue}-->` : n.outerHTML);
  function parseInto(parent, html) {
    const stack = [parent];
    const re = new RegExp(TOKEN.source, 'g');
    let m;
    while ((m = re.exec(html))) {
      const top = stack.at(-1);
      if (m[1] !== undefined) top.appendChild(new Comment(m[1]));
      else if (m[2]) {
        const i = stack.findLastIndex((e, n) => n > 0 && e.tagName === m[2].toUpperCase());
        if (i > 0) stack.length = i;
      } else if (m[3]) {
        const el = new Element(m[3]);
        for (const a of m[4].matchAll(ATTR)) el.setAttribute(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
        top.appendChild(el);
        const tag = m[3].toLowerCase();
        if (RAW.has(tag)) {
          const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
          const text = html.slice(re.lastIndex, end < 0 ? html.length : end);
          if (text) el.appendChild(new Text(tag === 'textarea' ? decode(text) : text));
          re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
        } else if (!m[5] && !VOID.has(tag)) stack.push(el);
      } else top.appendChild(new Text(decode(m[6])));
    }
  }
  const fragment = (html) => { const f = new Fragment(); parseInto(f, html); return f; };
  class Element extends Node {
    constructor(tag) {
      super();
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.nodeName = this.tagName;
      this.attrMap = new Map();
      this.style = { setProperty() {}, removeProperty() {} };
      const el = this;
      this.dataset = new Proxy({}, {
        get: (_, k) => (typeof k === 'string' ? el.getAttribute(dataAttr(k)) ?? undefined : undefined),
        set: (_, k, v) => { el.setAttribute(dataAttr(k), v); return true; },
        deleteProperty: (_, k) => { el.removeAttribute(dataAttr(k)); return true; },
      });
      const classes = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      const setClasses = (list) => el.setAttribute('class', [...new Set(list)].join(' '));
      this.classList = {
        contains: (c) => classes().includes(c),
        add: (...cs) => setClasses([...classes(), ...cs]),
        remove: (...cs) => setClasses(classes().filter((c) => !cs.includes(c))),
        toggle: (c, on = !classes().includes(c)) => { if (on) setClasses([...classes(), c]); else setClasses(classes().filter((x) => x !== c)); return on; },
      };
    }
    get attributes() { return [...this.attrMap].map(([name, value]) => ({ name, value })); }
    getAttribute(k) { return this.attrMap.get(k) ?? null; }
    setAttribute(k, v) { this.attrMap.set(k, String(v)); }
    removeAttribute(k) { this.attrMap.delete(k); }
    hasAttribute(k) { return this.attrMap.has(k); }
    get id() { return this.getAttribute('id') ?? ''; }
    get value() { return this._value ?? (this.tagName === 'TEXTAREA' ? this.textContent : this.getAttribute('value') ?? ''); }
    set value(v) { this._value = String(v); this._sel = [this._value.length, this._value.length, 'none']; }
    get selectionStart() { return (this._sel ?? [this.value.length])[0]; }
    get selectionEnd() { return (this._sel ?? [0, this.value.length])[1]; }
    get selectionDirection() { return (this._sel ?? [0, 0, 'none'])[2]; }
    setSelectionRange(start, end, dir = 'none') { this._sel = [start, end, dir]; }
    get content() { return this; }
    matches(sel) { return matchList(this, parse(sel), this); }
    closest(sel) { for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    focus() { if (this.isConnected) document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    scrollIntoView() {}
    cloneNode() { return fragment(this.outerHTML).firstChild; }
    animate() { return { finished: Promise.resolve(), cancel() {} }; }
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
    showModal() { this.open = true; this.modal = true; }
    show() { this.open = true; this.modal = false; }
    close() { this.open = false; }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
    set innerHTML(html) { this.replaceChildren(); parseInto(this, String(html)); }
    get outerHTML() {
      const tag = this.tagName.toLowerCase();
      const attrs = this.attributes.map(({ name, value }) => ` ${name}="${escAttr(value)}"`).join('');
      return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
    }
    set outerHTML(html) { this.replaceWith(fragment(String(html))); }
    insertAdjacentHTML(pos, html) {
      const f = fragment(String(html));
      if (pos === 'beforebegin') this.parentNode.insertBefore(f, this);
      else if (pos === 'afterbegin') this.insertBefore(f, this.firstChild);
      else if (pos === 'beforeend') this.appendChild(f);
      else this.parentNode.insertBefore(f, this.nextSibling);
    }
  }
  for (const p of ['hidden', 'open', 'disabled', 'checked']) {
    Object.defineProperty(Element.prototype, p, { get() { return this.hasAttribute(p); }, set(v) { if (v) this.setAttribute(p, ''); else this.removeAttribute(p); } });
  }
  document.body = new Element('body');
  document.createElement = (tag) => new Element(tag);
  return { Element, Text };
}
