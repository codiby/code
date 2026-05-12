//! Embedded browser preview for the `browser_open` MCP tool.
//!
//! Each preview is a *child* `Webview` attached to the main window via
//! `Window::add_child` (Tauri 2's `unstable` API). This puts the page on a
//! native webview surface that sits ON TOP of the main React UI at the
//! position/size the React panel computes — same window, no new OS chrome.
//!
//! The React side owns the layout: it measures the body rect of the
//! browser-preview panel with a ResizeObserver and calls
//! `browser_preview_set_bounds` whenever the rect moves or resizes
//! (splitter drag, fullscreen toggle, window resize).
//!
//! Wire protocol with the injected inspector script is unchanged from the
//! prior WebviewWindow-based implementation:
//!
//!   parent → webview:   `webview.eval()` into `window.__codibyInspector.*`
//!                        - setInspecting(bool)
//!                        - setComments(Comment[])
//!
//!   webview → parent:   `invoke('browser_preview_emit', { label, event, payload })`
//!                       Rust forwards as `app.emit_to("main", ...)`.
//!                       Events:
//!                        - "browser-preview://ready"
//!                        - "browser-preview://comments-changed"
//!                        - "browser-preview://inspect-auto-off"
//!                        - "browser-preview://url-changed"

use serde::{Deserialize, Serialize};
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime,
    WebviewBuilder, WebviewUrl,
};
use url::Url;

const MAIN_WINDOW_LABEL: &str = "main";

fn validate_label(label: &str) -> Result<(), String> {
    if label.is_empty() || label.len() > 80 {
        return Err("label must be 1..=80 chars".into());
    }
    if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("label must match [a-zA-Z0-9_-]+".into());
    }
    Ok(())
}

const INSPECTOR_SCRIPT_TEMPLATE: &str = r#"
(function() {
  if (window.__codibyBrowserInspectorBooted) return;
  window.__codibyBrowserInspectorBooted = true;

  var LABEL = "__LABEL__";
  var INTERNALS = window.__TAURI_INTERNALS__;
  if (!INTERNALS || typeof INTERNALS.invoke !== 'function') return;

  function emit(event, payload) {
    try {
      INTERNALS.invoke('browser_preview_emit', { label: LABEL, event: event, payload: payload == null ? null : JSON.stringify(payload) });
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
      // Echo-suppression: openPopup already flipped `inspecting` to false
      // locally and emitted inspect-auto-off so React syncs. React then
      // pushes the new state right back down through this method; if we
      // don't no-op the redundant transition, the side effect below
      // (closePopup) destroys the popup the user is about to type in.
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

  // Relay the current URL to the parent on boot + every navigation we can
  // observe. Cross-document navigations re-run this initialization script
  // (so boot fires the new URL automatically); pushState/replaceState/popstate
  // covers SPA-style same-document navigation that we can't otherwise see.
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
"#;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrowserComment {
    pub id: String,
    pub selector: String,
    pub summary: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RelayPayload {
    pub label: String,
    pub payload: Option<String>,
}

/// Locate the embedded child webview by label. `app.get_webview(label)` is
/// the right lookup since we're storing it on the main window via
/// `add_child` — `get_webview_window` only finds standalone WebviewWindows.
fn find_child<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<tauri::Webview<R>> {
    app.webviews()
        .into_iter()
        .find(|(l, _)| l == label)
        .map(|(_, wv)| wv)
}

#[tauri::command]
pub async fn open_browser_preview(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_label(&label)?;
    let _ = title; // accepted for API symmetry; the embedded surface has no title chrome

    let parsed: Url = url
        .parse()
        .map_err(|e: url::ParseError| format!("invalid url: {}", e))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http/https URLs are supported".into());
    }

    // Close any prior child webview with the same label before rebuilding.
    if let Some(existing) = find_child(&app, &label) {
        let _ = existing.close();
    }

    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let script = INSPECTOR_SCRIPT_TEMPLATE.replace("__LABEL__", &label);

    // Capture the label for the on_page_load closure so we can identify
    // which preview the event came from when relaying back to the main
    // window. Cheap String clone — once per browser_open call.
    let emit_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(&script)
        // `on_page_load` fires from the Tauri runtime once a real HTTP-level
        // navigation commits — bypassing the injected JS path, which can
        // miss redirects or be silenced by page CSP. We only act on the
        // `Finished` variant so the URL bar reflects the destination, not
        // an in-progress load that might fail.
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let url = payload.url().as_str().to_string();
            let inner = match serde_json::to_string(&serde_json::json!({ "url": url })) {
                Ok(s) => s,
                Err(_) => return,
            };
            // Broadcast via `app.emit` rather than scoping to the main
            // window — it reaches every listener regardless of which
            // webview owns the events-plugin subscription, more forgiving
            // when the main window's listener registration is racing with
            // this fire.
            let _ = webview.app_handle().emit(
                "browser-preview://url-changed",
                RelayPayload { label: emit_label.clone(), payload: Some(inner) },
            );
        });

    main.as_ref()
        .window()
        .add_child(
            builder,
            LogicalPosition::new(x.max(0.0), y.max(0.0)),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn close_browser_preview(app: AppHandle, label: String) -> Result<bool, String> {
    validate_label(&label)?;
    match find_child(&app, &label) {
        Some(w) => {
            w.close().map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn browser_preview_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    validate_label(&label)?;
    let Some(w) = find_child(&app, &label) else { return Ok(false); };
    w.set_position(LogicalPosition::new(x.max(0.0), y.max(0.0)))
        .map_err(|e| e.to_string())?;
    w.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn browser_preview_set_inspect(
    app: AppHandle,
    label: String,
    enabled: bool,
) -> Result<bool, String> {
    validate_label(&label)?;
    let Some(w) = find_child(&app, &label) else { return Ok(false); };
    let script = format!(
        "window.__codibyInspector && window.__codibyInspector.setInspecting({});",
        if enabled { "true" } else { "false" }
    );
    w.eval(&script).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn browser_preview_set_comments(
    app: AppHandle,
    label: String,
    comments: Vec<BrowserComment>,
) -> Result<bool, String> {
    validate_label(&label)?;
    let Some(w) = find_child(&app, &label) else { return Ok(false); };
    let json = serde_json::to_string(&comments).map_err(|e| e.to_string())?;
    let script = format!(
        "window.__codibyInspector && window.__codibyInspector.setComments({});",
        json
    );
    w.eval(&script).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Show or hide the child webview. Used by the frontend to get the page
/// out of the way when an overlay (like the Cmd+K command palette) opens
/// — the OS-level webview surface sits on top of all React content, so
/// without this it would obscure the overlay.
#[tauri::command]
pub async fn browser_preview_set_visible(
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<bool, String> {
    validate_label(&label)?;
    let Some(w) = find_child(&app, &label) else { return Ok(false); };
    if visible {
        w.show().map_err(|e| e.to_string())?;
    } else {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// Drive in-webview navigation: back / forward / reload / goto. Done via
/// `eval` because Tauri 2's `Webview` doesn't expose direct navigation
/// methods; `history.go(-1)` / `window.location.href = …` are the standard
/// browser primitives the embedded page already understands.
#[tauri::command]
pub async fn browser_preview_navigate(
    app: AppHandle,
    label: String,
    action: String,
    url: Option<String>,
) -> Result<bool, String> {
    validate_label(&label)?;
    let Some(w) = find_child(&app, &label) else { return Ok(false); };
    let script = match action.as_str() {
        "back" => "history.back();".to_string(),
        "forward" => "history.forward();".to_string(),
        "reload" => "window.location.reload();".to_string(),
        "goto" => {
            let raw = url.ok_or_else(|| "goto requires `url`".to_string())?;
            let parsed: Url = raw
                .parse()
                .map_err(|e: url::ParseError| format!("invalid url: {}", e))?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err("Only http/https URLs are supported".into());
            }
            // JSON-encode the URL to safely escape quotes / backslashes /
            // control chars when interpolating into the JS string literal.
            let encoded = serde_json::to_string(parsed.as_str()).map_err(|e| e.to_string())?;
            format!("window.location.href = {};", encoded)
        }
        other => return Err(format!("unknown action: {}", other)),
    };
    w.eval(&script).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn browser_preview_emit(
    app: AppHandle,
    label: String,
    event: String,
    payload: Option<String>,
) -> Result<(), String> {
    validate_label(&label)?;
    if !event.starts_with("browser-preview://") {
        return Err("event must be namespaced under browser-preview://".into());
    }
    // `app.emit` (broadcast) — matches the URL-relay path in on_page_load,
    // which is the one we verified reaches the React listener. The earlier
    // attempt at `main.emit` (webview-scoped) silently never delivered;
    // staying on broadcast keeps both relay paths identical.
    app.emit(&event, RelayPayload { label, payload })
        .map_err(|e| e.to_string())
}
