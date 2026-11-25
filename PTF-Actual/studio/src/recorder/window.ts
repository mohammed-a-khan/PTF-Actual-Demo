/**
 * Recording in a real browser window (on the tester's computer, for single sign-on, client certificates and
 * applications that refuse a hidden browser): this script runs in every page and frame of the window.
 *
 * Pointer actions (click, double-click, right-click, drag) are caught before the application sees them and
 * sent to the recorder, which describes the element, writes the step and then performs the action, exactly
 * as for a click on the Studio's picture (lists, file choosers and dialogs are answered in the Studio).
 * Typing is the browser's own: the recorder is told where it starts (and the field's value before it) and
 * writes the field's text when the focus moves on. Keys that act (Enter, Escape, Tab, arrows, F-keys,
 * shortcuts) are sent like pointer actions. Hovering and scrolling are left to the page.
 *
 * While the recorder performs an action the page's own message is still waiting for its answer (busy): the
 * events the recorder makes are then left to the page.
 *
 * In pick mode (a check chosen in the Studio's toolbar) the element under the pointer is outlined and a
 * click picks it instead of acting.
 */
export const WINDOW_BINDING = '__csWindowInput';

export interface WindowMessage {
    type: 'click' | 'dblclick' | 'rightclick' | 'drag' | 'pick' | 'key' | 'typing';
    x?: number; y?: number; x2?: number; y2?: number; key?: string; value?: string;
}

export const WINDOW_JS = `(() => {
  if (window.__csWindowInstalled) return;
  Object.defineProperty(window, '__csWindowInstalled', { value: true, enumerable: false });
  var busy = 0;
  var send = function (m, wait) {
    var f = window.${WINDOW_BINDING};
    if (typeof f !== 'function') return;
    if (!wait) { try { f(m); } catch (e) { /* closed */ } return; }
    // After this task: the browser's own events that follow (mouseup, click, dblclick, contextmenu) are still
    // the person's, swallowed; from then on until the answer the events are the recorder's.
    setTimeout(function () {
      busy++;
      Promise.resolve().then(function () { return f(m); }).catch(function () {}).then(function () { busy--; });
    }, 0);
  };
  var swallow = function (e) { e.preventDefault(); e.stopImmediatePropagation(); };
  var mine = function (e) { return !busy && e.isTrusted; };
  var opts = { capture: true };
  // The browser's own mouse events of a caught action never reach the page.
  ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'contextmenu'].forEach(function (t) {
    window.addEventListener(t, function (e) { if (mine(e)) swallow(e); }, opts);
  });
  var down = null, last = null, timer = null;
  window.addEventListener('pointerdown', function (e) {
    if (!mine(e) || e.pointerType === 'touch') return;
    swallow(e);
    down = { x: e.clientX, y: e.clientY, b: e.button };
  }, opts);
  window.addEventListener('pointerup', function (e) {
    if (!mine(e) || !down) return;
    swallow(e);
    var d = down; down = null;
    if (d.b === 2) { send({ type: 'rightclick', x: d.x, y: d.y }, true); return; }
    if (d.b !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) { send({ type: 'drag', x: d.x, y: d.y, x2: e.clientX, y2: e.clientY }, true); return; }
    if (window.__csPick) { send({ type: 'pick', x: d.x, y: d.y }, true); return; }
    // A second click close by, soon: a double-click (the first is not sent).
    if (timer && last && Math.hypot(last.x - d.x, last.y - d.y) < 6) { clearTimeout(timer); timer = null; last = null; send({ type: 'dblclick', x: d.x, y: d.y }, true); return; }
    last = { x: d.x, y: d.y };
    timer = setTimeout(function () { timer = null; last = null; send({ type: 'click', x: d.x, y: d.y }, true); }, 250);
  }, opts);
  // Keys that act; typing (and paste, delete) is the browser's own, the recorder only told where it starts.
  var ACT = /^(Enter|Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|F\\d{1,2})$/;
  window.addEventListener('keydown', function (e) {
    if (!mine(e)) return;
    var mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta'].filter(Boolean);
    var k = e.key;
    var shortcut = mods.length && k.length === 1 && !/^[acvxzy]$/i.test(k);
    if (!ACT.test(k) && !shortcut) return;
    swallow(e);
    var parts = mods.slice();
    if (e.shiftKey && (k === 'Tab' || mods.length)) parts.push('Shift');
    parts.push(k.length === 1 && mods.length ? k.toLowerCase() : k);
    send({ type: 'key', key: parts.join('+') }, true);
  }, opts);
  var active = function () { var a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  window.addEventListener('beforeinput', function (e) {
    if (busy) return;
    var a = active();
    if (!a) return;
    var v = a.isContentEditable ? a.innerText : ('value' in a ? String(a.value) : null);
    if (v !== null) send({ type: 'typing', value: v }, false);
  }, opts);
  // Pick mode: the element under the pointer outlined.
  var outlined = null, before = '';
  var unmark = function () { if (outlined) { outlined.style.outline = before; outlined = null; } };
  window.addEventListener('mouseover', function (e) {
    if (!window.__csPick) { unmark(); return; }
    var t = e.composedPath ? e.composedPath()[0] : e.target;
    if (!t || !t.style || t === outlined) return;
    unmark();
    outlined = t; before = t.style.outline; t.style.outline = '2px solid #1677ff';
  }, opts);
  window.addEventListener('__csPickOff', unmark);
})();`;
