/**
 * Inspector overlay injected into the sandboxed mockup iframe.
 *
 * The iframe runs `sandbox="allow-scripts"` (no `allow-same-origin`), so the
 * parent React app cannot reach into the iframe's DOM. We instead inject a
 * small script that:
 *
 *   - listens for postMessage commands from the parent (toggle inspect mode,
 *     replace the comment list)
 *   - on click in inspect mode, computes a CSS selector for the picked
 *     element and posts it back so the parent can open a comment popup
 *   - draws numbered dots over each commented element and re-positions them
 *     on scroll/resize/mockup re-render
 *   - on dot click, posts back so the parent can re-open the existing
 *     comment for editing
 *
 * Wire format (everything parent ↔ iframe goes through this protocol):
 *
 *   parent → iframe:  { __codiby_mockup_cmd: true, type: 'set_inspector', enabled }
 *                     { __codiby_mockup_cmd: true, type: 'set_comments', comments: [{id, selector}] }
 *
 *   iframe → parent:  { __codiby_mockup: true, type: 'mockup_ready' }
 *                     { __codiby_mockup: true, type: 'mockup_pick',  selector, summary, x, y }
 *                     { __codiby_mockup: true, type: 'mockup_dot',   commentId, x, y }
 */

export type MockupComment = {
  id: string;
  selector: string;
  summary: string;
  text: string;
};

export type MockupInboundMsg =
  | { type: 'mockup_ready' }
  | { type: 'mockup_pick'; selector: string; summary: string; x: number; y: number }
  | { type: 'mockup_dot'; commentId: string; x: number; y: number };

const INSPECTOR_SCRIPT = String.raw`
(function() {
  if (window.__codibyInspectorBooted) return;
  window.__codibyInspectorBooted = true;

  var PARENT = window.parent;
  var inspecting = false;
  var comments = [];        // [{id, selector, idx}]
  var dotEls = new Map();   // id -> dot DOM node

  function send(msg) {
    msg.__codiby_mockup = true;
    try { PARENT.postMessage(msg, '*'); } catch (e) {}
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return 'body';
    if (el === document.body) return 'body';
    var parts = [];
    var cur = el;
    var hops = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && hops < 8) {
      var part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(part + '#' + CSS.escape(cur.id));
        return parts.join(' > ');
      }
      if (cur.className && typeof cur.className === 'string') {
        var cls = cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) part += '.' + cls.map(function(c){return CSS.escape(c);}).join('.');
      }
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function(c){return c.tagName === cur.tagName;});
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      hops++;
    }
    return parts.join(' > ');
  }

  function summaryFor(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) s += '.' + cls.join('.');
    }
    var t = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (t) s += ' "' + t + '"';
    return s;
  }

  function findEl(selector) {
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  // Hover highlight (only in inspect mode).
  var hl = document.createElement('div');
  hl.id = '__codiby_hl';
  hl.style.cssText = [
    'position:fixed','pointer-events:none','box-sizing:border-box',
    'border:2px solid #8b5cf6','background:rgba(139,92,246,0.12)',
    'z-index:2147483646','display:none',
  ].join(';');

  function onMove(e) {
    if (!inspecting) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hl || el.classList && el.classList.contains('__codiby_dot')) {
      hl.style.display = 'none'; return;
    }
    var r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
  }

  function onClickCapture(e) {
    if (!inspecting) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation && e.stopImmediatePropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    var sel = selectorFor(el);
    var sum = summaryFor(el);
    var r = el.getBoundingClientRect();
    send({ type: 'mockup_pick', selector: sel, summary: sum, x: r.left + r.width/2, y: r.top + r.height });
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('mousedown', function(e){ if (inspecting){ e.preventDefault(); e.stopPropagation(); }}, true);

  function clearDots() {
    dotEls.forEach(function(d){ d.remove(); });
    dotEls.clear();
  }

  function makeDot(c) {
    var d = document.createElement('div');
    d.className = '__codiby_dot';
    d.textContent = String(c.idx + 1);
    d.style.cssText = [
      'position:fixed','width:20px','height:20px','border-radius:50%',
      'background:#8b5cf6','border:2px solid #fff','color:#fff',
      'font:bold 11px/16px -apple-system,sans-serif','text-align:center',
      'cursor:pointer','z-index:2147483647',
      'box-shadow:0 1px 4px rgba(0,0,0,.45)','user-select:none',
    ].join(';');
    d.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var el = findEl(c.selector);
      var x = 0, y = 0;
      if (el) { var r = el.getBoundingClientRect(); x = r.left + r.width/2; y = r.top + r.height; }
      else { x = parseFloat(d.style.left) + 10; y = parseFloat(d.style.top) + 20; }
      send({ type: 'mockup_dot', commentId: c.id, x: x, y: y });
    }, true);
    return d;
  }

  function place(d, el) {
    var r = el.getBoundingClientRect();
    d.style.left = (r.left - 10) + 'px';
    d.style.top  = (r.top  - 10) + 'px';
    d.style.display = (r.width === 0 && r.height === 0) ? 'none' : 'block';
  }

  function renderDots() {
    clearDots();
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      var el = findEl(c.selector);
      if (!el) continue;
      var d = makeDot(c);
      document.documentElement.appendChild(d);
      dotEls.set(c.id, d);
      place(d, el);
    }
  }

  function reposition() {
    dotEls.forEach(function(d, id){
      var c = null;
      for (var i = 0; i < comments.length; i++) if (comments[i].id === id) { c = comments[i]; break; }
      if (!c) return;
      var el = findEl(c.selector);
      if (!el) { d.style.display = 'none'; return; }
      place(d, el);
    });
  }

  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  window.addEventListener('message', function(e){
    var m = e.data;
    if (!m || !m.__codiby_mockup_cmd) return;
    if (m.type === 'set_inspector') {
      inspecting = !!m.enabled;
      hl.style.display = 'none';
      document.documentElement.style.cursor = inspecting ? 'crosshair' : '';
    } else if (m.type === 'set_comments') {
      comments = (m.comments || []).map(function(c, i){ return { id: c.id, selector: c.selector, idx: i }; });
      renderDots();
    }
  });

  function boot() {
    if (!document.body) { setTimeout(boot, 16); return; }
    document.documentElement.appendChild(hl);
    send({ type: 'mockup_ready' });
  }
  boot();
})();
`;

/**
 * Wraps the user's mockup HTML so the inspector script runs inside the
 * iframe. We inject before `</body>` if present (so the document parses
 * naturally), or just append for fragments.
 */
export function wrapMockupHtml(html: string): string {
  const tag = `<script>${INSPECTOR_SCRIPT}</script>`;
  const lower = html.toLowerCase();
  const idx = lower.lastIndexOf('</body>');
  if (idx !== -1) return html.slice(0, idx) + tag + html.slice(idx);
  return html + tag;
}
