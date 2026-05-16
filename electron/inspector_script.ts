/**
 * Inspector overlay injected into every browser-preview page.
 *
 * Calls `window.__codiby_relay(event, payload)` (exposed by
 * `preview_preload.ts`) to push events to the host renderer.
 *
 * `__LABEL__` is replaced per preview before injection.
 */
export const INSPECTOR_SCRIPT_TEMPLATE = String.raw`
(function() {
  if (window.__codibyBrowserInspectorBooted) return;
  window.__codibyBrowserInspectorBooted = true;

  var LABEL = "__LABEL__";
  var RELAY = window.__codiby_relay;
  if (typeof RELAY !== 'function') return;

  function emit(event, payload) {
    try {
      RELAY(event, payload == null ? null : JSON.stringify(payload));
    } catch (e) {}
  }

  var inspecting = false;
  var comments = [];
  var dotEls = new Map();
  var popupEl = null;
  var popupCommentId = null;
  var popupSelector = '';
  var popupSummary = '';

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

  function broadcastComments() {
    emit('browser-preview://comments-changed', comments);
  }

  var hl = document.createElement('div');
  hl.id = '__codiby_browser_hl';
  hl.style.cssText = [
    'position:fixed','pointer-events:none','box-sizing:border-box',
    'border:2px solid #38bdf8','background:rgba(56,189,248,0.12)',
    'z-index:2147483646','display:none',
  ].join(';');

  function onMove(e) {
    if (!inspecting) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hl || (el.classList && el.classList.contains('__codiby_dot')) || (popupEl && popupEl.contains(el))) {
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
    if (popupEl && popupEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    var sel = selectorFor(el);
    var sum = summaryFor(el);
    var r = el.getBoundingClientRect();
    openPopup(null, sel, sum, r.left + r.width/2, r.top + r.height, '', true);
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('mousedown', function(e){
    if (inspecting && popupEl && popupEl.contains(e.target)) return;
    if (inspecting) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  function clearDots() {
    dotEls.forEach(function(d){ d.remove(); });
    dotEls.clear();
  }

  function makeDot(c, idx) {
    var d = document.createElement('div');
    d.className = '__codiby_dot';
    d.textContent = String(idx + 1);
    d.style.cssText = [
      'position:fixed','width:20px','height:20px','border-radius:50%',
      'background:#0284c7','border:2px solid #fff','color:#fff',
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
      openPopup(c.id, c.selector, c.summary, x, y, c.text, false);
    }, true);
    return d;
  }

  function placeDot(d, el) {
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
      var d = makeDot(c, i);
      document.documentElement.appendChild(d);
      dotEls.set(c.id, d);
      placeDot(d, el);
    }
  }

  function reposition() {
    dotEls.forEach(function(d, id){
      var c = null;
      for (var i = 0; i < comments.length; i++) if (comments[i].id === id) { c = comments[i]; break; }
      if (!c) return;
      var el = findEl(c.selector);
      if (!el) { d.style.display = 'none'; return; }
      placeDot(d, el);
    });
  }

  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  function closePopup() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
    popupCommentId = null;
    popupSelector = '';
    popupSummary = '';
  }

  function genId() {
    return 'c_' + Math.random().toString(36).slice(2, 10);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function openPopup(commentId, selector, summary, x, y, text, fromPick) {
    closePopup();
    popupCommentId = commentId;
    popupSelector = selector;
    popupSummary = summary;

    var wasInspecting = inspecting;
    if (fromPick && wasInspecting) {
      inspecting = false;
      hl.style.display = 'none';
      document.documentElement.style.cursor = '';
      emit('browser-preview://inspect-auto-off', null);
    }

    var POPUP_W = 280;
    var POPUP_H = 180;
    var left = clamp(x - POPUP_W / 2, 8, window.innerWidth - POPUP_W - 8);
    var top  = clamp(y + 8,           8, window.innerHeight - POPUP_H - 8);

    var root = document.createElement('div');
    root.style.cssText = [
      'position:fixed','left:' + left + 'px','top:' + top + 'px',
      'width:' + POPUP_W + 'px','z-index:2147483647',
      'background:#1f1f1f','border:1px solid rgba(14,165,233,0.4)',
      'border-radius:8px','box-shadow:0 8px 24px rgba(0,0,0,.5)',
      'color:#e4e4e7','font:13px/1.4 -apple-system,sans-serif',
      'box-sizing:border-box',
    ].join(';');

    var head = document.createElement('div');
    head.style.cssText = 'padding:6px 10px;border-bottom:1px solid #2a2a2a;display:flex;align-items:center;gap:6px;';
    var dot = document.createElement('span');
    dot.textContent = '◐';
    dot.style.cssText = 'color:#38bdf8;font-size:10px;flex-shrink:0;';
    var sumEl = document.createElement('span');
    sumEl.textContent = summary;
    sumEl.title = selector;
    sumEl.style.cssText = 'font:11px/1 ui-monospace,monospace;color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    head.appendChild(dot);
    head.appendChild(sumEl);

    var ta = document.createElement('textarea');
    ta.value = text || '';
    ta.placeholder = 'Comment on this element… (Cmd/Ctrl+Enter to save, Esc to cancel)';
    ta.rows = 4;
    ta.style.cssText = [
      'display:block','width:100%','box-sizing:border-box',
      'background:transparent','color:#e4e4e7','border:0','outline:none',
      'padding:8px 10px','resize:none','font:13px/1.4 inherit',
    ].join(';');
    setTimeout(function(){ ta.focus(); }, 0);

    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:6px;padding:6px 8px;border-top:1px solid #2a2a2a;align-items:center;';

    var btnDelete = document.createElement('button');
    btnDelete.textContent = 'Delete';
    btnDelete.style.cssText = 'font:11px/1 inherit;color:#f87171;background:transparent;border:0;padding:4px 8px;cursor:pointer;border-radius:4px;';
    btnDelete.addEventListener('click', function(){
      if (popupCommentId == null) { closePopup(); return; }
      comments = comments.filter(function(c){ return c.id !== popupCommentId; });
      renderDots();
      broadcastComments();
      closePopup();
    });

    var spacer = document.createElement('span');
    spacer.style.flex = '1';

    var btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'font:11px/1 inherit;color:#a1a1aa;background:transparent;border:0;padding:4px 8px;cursor:pointer;border-radius:4px;';
    btnCancel.addEventListener('click', function(){ closePopup(); });

    var btnSave = document.createElement('button');
    btnSave.textContent = 'Save';
    btnSave.style.cssText = 'font:11px/1 inherit;color:#fff;background:#0284c7;border:0;padding:4px 10px;cursor:pointer;border-radius:4px;';
    btnSave.addEventListener('click', save);

    function save() {
      var value = ta.value.trim();
      if (!value) { closePopup(); return; }
      if (popupCommentId != null) {
        comments = comments.map(function(c){ return c.id === popupCommentId ? Object.assign({}, c, { text: value }) : c; });
      } else {
        comments = comments.concat([{ id: genId(), selector: popupSelector, summary: popupSummary, text: value }]);
      }
      renderDots();
      broadcastComments();
      closePopup();
    }

    ta.addEventListener('keydown', function(e){
      if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });

    if (popupCommentId != null) foot.appendChild(btnDelete);
    foot.appendChild(spacer);
    foot.appendChild(btnCancel);
    foot.appendChild(btnSave);

    root.appendChild(head);
    root.appendChild(ta);
    root.appendChild(foot);
    document.documentElement.appendChild(root);
    popupEl = root;
  }

  window.__codibyInspector = {
    setInspecting: function(next) {
      var v = !!next;
      if (inspecting === v) return;
      inspecting = v;
      hl.style.display = 'none';
      document.documentElement.style.cursor = inspecting ? 'crosshair' : '';
      if (!inspecting) closePopup();
    },
    setComments: function(next) {
      comments = (Array.isArray(next) ? next : []).map(function(c){ return { id: c.id, selector: c.selector, summary: c.summary || c.selector, text: c.text || '' }; });
      renderDots();
    },
    clear: function() {
      comments = [];
      renderDots();
      broadcastComments();
    },
  };

  function emitUrl() {
    try { emit('browser-preview://url-changed', { url: String(window.location.href) }); } catch (e) {}
  }
  window.addEventListener('popstate', emitUrl);
  window.addEventListener('hashchange', emitUrl);
  try {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function() { var r = origPush.apply(this, arguments); emitUrl(); return r; };
    history.replaceState = function() { var r = origReplace.apply(this, arguments); emitUrl(); return r; };
  } catch (e) {}

  function boot() {
    if (!document.body) { setTimeout(boot, 16); return; }
    document.documentElement.appendChild(hl);
    emit('browser-preview://ready', null);
    emitUrl();
  }
  boot();
})();
`;

export function renderInspectorScript(label: string): string {
  return INSPECTOR_SCRIPT_TEMPLATE.replace('__LABEL__', label);
}
