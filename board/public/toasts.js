(function () {
  function create(root) {
    const stack = document.createElement('div');
    stack.setAttribute('class', 'toast-stack');
    stack.setAttribute('aria-label', 'Notifications');
    root.appendChild(stack);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const enterTime = () => reduced.matches ? 80 : 150;
    const exitTime = () => reduced.matches ? 100 : 200;
    let entries = [];
    let pending = [];
    let frame = 0;
    let destroyed = false;
    const held = (item) => !item.forced && item.holds.size > 0;
    const opacity = (item) => held(item) || item.phase === 'solid' ? 1
      : item.phase === 'in' ? 1 - item.remaining / item.fade : item.from * item.remaining / item.fade;

    function layout() {
      let bottom = 0;
      for (const item of [...entries].reverse()) {
        bottom += item.el.getBoundingClientRect().height;
        item.row.style.transform = `translateY(${-bottom}px)`;
        bottom += 8;
      }
    }

    function draw() {
      for (const item of entries) item.el.style.opacity = Math.max(0, Math.min(1, opacity(item)));
    }

    function dismiss(item) {
      if (!entries.includes(item) || item.forced) return;
      advance(item, performance.now());
      item.from = Math.max(0, opacity(item));
      item.phase = 'out';
      item.remaining = item.fade = exitTime();
      item.last = performance.now();
      item.forced = true;
      item.holds.clear();
      draw();
    }

    function advance(item, now) {
      if (!held(item)) item.remaining -= Math.max(0, now - item.last);
      item.last = now;
      while (item.remaining <= 0) {
        if (item.phase === 'out') return false;
        item.phase = item.phase === 'in' ? 'solid' : 'out';
        item.from = 1;
        item.fade = exitTime();
        item.remaining += item.phase === 'solid' ? item.duration : item.fade;
      }
      return true;
    }

    function hold(item, source, on) {
      if (!entries.includes(item) || item.forced || item.holds.has(source) === on) return;
      advance(item, performance.now());
      if (on) {
        item.holds.add(source);
        if (item.phase === 'in') { item.phase = 'solid'; item.remaining = item.duration; }
        if (item.phase === 'out') { item.remaining = item.fade = exitTime(); item.from = 1; }
      } else item.holds.delete(source);
      draw();
    }

    function attach(message) {
      const row = document.createElement('div');
      row.setAttribute('class', 'toast-row');
      row.style.transition = 'none';
      const el = document.createElement('div');
      el.setAttribute('class', 'toast');
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      el.setAttribute('tabindex', '0');
      el.textContent = message.text;
      row.appendChild(el);
      const item = { ...message, row, el, phase: 'in', remaining: enterTime(), fade: enterTime(),
        from: 1, last: performance.now(), holds: new Set(), forced: false, off: [] };
      const on = (type, fn) => {
        el.addEventListener(type, fn);
        item.off.push(() => el.removeEventListener(type, fn));
      };
      let touch = null;
      let suppressClickUntil = 0;
      on('pointerenter', (e) => { if (e.pointerType === 'mouse') hold(item, 'hover', true); });
      on('pointerleave', (e) => { if (e.pointerType === 'mouse') hold(item, 'hover', false); });
      on('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        touch = { id: e.pointerId, at: performance.now(), x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
        hold(item, 'touch', true);
      });
      function release(e) {
        if (!touch || touch.id !== e.pointerId) return;
        const wasHold = performance.now() - touch.at > 350 || Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 10;
        if (wasHold || e.type !== 'pointerup') suppressClickUntil = performance.now() + 600;
        touch = null;
        hold(item, 'touch', false);
      }
      on('pointerup', release);
      on('pointercancel', release);
      on('lostpointercapture', release);
      on('contextmenu', (e) => e.preventDefault());
      on('click', () => { if (performance.now() >= suppressClickUntil) dismiss(item); });
      on('keydown', (e) => {
        if (!['Escape', 'Enter', ' '].includes(e.key)) return;
        e.preventDefault();
        dismiss(item);
      });
      entries.push(item);
      stack.appendChild(row);
      observer.observe(el);
      layout();
      row.getBoundingClientRect();
      row.style.transition = '';
      if (matchMedia('(hover: hover)').matches && el.matches(':hover')) hold(item, 'hover', true);
    }

    function drain() {
      while (pending.length && entries.length < 3) attach(pending.shift());
      // The next arrival waits for eviction's fade so four messages never show together.
      if (pending.length && entries.length === 3) dismiss(entries[0]);
    }

    function remove(item) {
      item.off.forEach((off) => off());
      observer.unobserve(item.el);
      item.row.remove();
    }

    function tick(now) {
      frame = 0;
      const expired = entries.filter((item) => !advance(item, now));
      for (const item of expired) remove(item);
      if (expired.length) {
        entries = entries.filter((item) => !expired.includes(item));
        drain();
        layout();
      }
      draw();
      if (entries.length) frame = requestAnimationFrame(tick);
    }

    function toast(text) {
      if (destroyed || !text.trim()) return;
      const length = Array.from(text.replace(/\s+/g, ' ').trim()).length;
      pending.push({ text, duration: length > 100 ? 5000 : 3000 });
      drain();
      draw();
      if (!frame) frame = requestAnimationFrame(tick);
    }

    function releaseHolds() {
      const now = performance.now();
      for (const item of entries) { advance(item, now); item.holds.clear(); }
      draw();
    }
    const visibility = () => { if (document.hidden) releaseHolds(); };
    window.addEventListener('blur', releaseHolds);
    document.addEventListener('visibilitychange', visibility);
    const observer = new ResizeObserver(layout);
    observer.observe(stack);
    function destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      entries.forEach(remove);
      observer.disconnect();
      window.removeEventListener('blur', releaseHolds);
      document.removeEventListener('visibilitychange', visibility);
      stack.remove();
      entries = [];
      pending = [];
    }
    return { toast, destroy };
  }
  globalThis.BoardToasts = { create };
})();
