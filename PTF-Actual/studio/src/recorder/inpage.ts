/**
 * Runs in every page and frame of the Studio's recording browser (an init script): it only describes
 * elements for the Studio, it never records or changes anything. The Studio asks it, before passing a
 * click or a key to the page, which element is under the pointer and how a test would find it.
 *  - target(el): the element a person means (the button around an icon, the link around a text…).
 *  - candidates(el): locators in the order a tester would want them (test id, role + name, label,
 *    placeholder, alt text, title, text, id, CSS), each with a guess whether it finds only this element.
 *    The Studio checks each guess with Playwright itself and uses the first that finds exactly it.
 *  - info(el): what the element is (field, list, check box, file input…) and its text and value.
 * Written as plain JavaScript (it is sent to the browser as text).
 */
/** The script with the project's locator policy applied in every page and frame. */
export function inpageWith(policy?: { ignoreId?: string; ignoreClass?: string }): string {
    if (!policy?.ignoreId && !policy?.ignoreClass) return INPAGE_JS;
    return `${INPAGE_JS}\n;(function () { if (window.__csRec && window.__csRec.policy) window.__csRec.policy(${JSON.stringify(policy.ignoreId ?? '')}, ${JSON.stringify(policy.ignoreClass ?? '')}); })();`;
}

export const INPAGE_JS = String.raw`(function () {
  if (window.__csRec) return;
  var norm = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var lower = function (s) { return norm(s).toLowerCase(); };
  var visible = function (e) {
    if (!e || !e.getClientRects || !e.getClientRects().length) return false;
    var st = getComputedStyle(e);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  var TEXT_TYPES = { text: 1, email: 1, password: 1, search: 1, tel: 1, url: 1, number: 1, date: 1, 'datetime-local': 1, month: 1, time: 1, week: 1, '': 1 };
  var editable = function (e) {
    if (!e) return false;
    if (e.isContentEditable) return true;
    if (e.tagName === 'TEXTAREA') return !e.disabled && !e.readOnly;
    if (e.tagName === 'INPUT') return TEXT_TYPES[(e.getAttribute('type') || '').toLowerCase()] === 1 && !e.disabled && !e.readOnly;
    return false;
  };
  // ARIA role as Playwright computes it for the common elements.
  var role = function (e) {
    var r = (e.getAttribute('role') || '').split(' ')[0];
    if (r) return r;
    var t = e.tagName;
    if (t === 'A' && e.hasAttribute('href')) return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'INPUT') {
      var ty = (e.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (ty === 'search') return e.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (ty === 'hidden' || ty === 'file' || ty === 'color' || ty === 'date' || ty === 'datetime-local' || ty === 'month' || ty === 'time' || ty === 'week') return '';
      return e.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'SELECT') return e.multiple || (e.size > 1) ? 'listbox' : 'combobox';
    if (t === 'OPTION') return 'option';
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (t === 'IMG') return e.getAttribute('alt') === '' ? 'presentation' : 'img';
    if (t === 'TABLE') return 'table';
    if (t === 'TR') return 'row';
    if (t === 'TD') return 'cell';
    if (t === 'TH') return 'columnheader';
    if (t === 'NAV') return 'navigation';
    if (t === 'DIALOG') return 'dialog';
    if (t === 'LI') return 'listitem';
    if (t === 'UL' || t === 'OL') return 'list';
    return '';
  };
  var byIds = function (ids) {
    return norm((ids || '').split(/\s+/).map(function (id) { var x = id && document.getElementById(id); return x ? x.textContent : ''; }).join(' '));
  };
  var labelText = function (e) {
    var parts = [];
    if (e.labels) for (var i = 0; i < e.labels.length; i++) {
      var c = e.labels[i].cloneNode(true);
      var ctl = c.querySelectorAll('input,select,textarea');
      for (var j = 0; j < ctl.length; j++) ctl[j].remove();
      parts.push(c.textContent);
    }
    return norm(parts.join(' '));
  };
  // Accessible name (the parts Playwright uses for getByRole name matching).
  var name = function (e) {
    var n = byIds(e.getAttribute('aria-labelledby'));
    if (n) return n;
    n = norm(e.getAttribute('aria-label'));
    if (n) return n;
    var t = e.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
      n = labelText(e);
      if (n) return n;
      var ty = (e.getAttribute('type') || '').toLowerCase();
      if (t === 'INPUT' && (ty === 'submit' || ty === 'button' || ty === 'reset')) return norm(e.value || (ty === 'submit' ? 'Submit' : ty === 'reset' ? 'Reset' : ''));
      if (t === 'INPUT' && ty === 'image') return norm(e.getAttribute('alt') || e.getAttribute('title'));
      return norm(e.getAttribute('placeholder') || e.getAttribute('title'));
    }
    if (t === 'IMG') return norm(e.getAttribute('alt') || e.getAttribute('title'));
    var r = role(e);
    if (r === 'button' || r === 'link' || r === 'heading' || r === 'tab' || r === 'menuitem' || r === 'option' || r === 'cell' || r === 'columnheader' || r === 'checkbox' || r === 'radio' || r === 'switch' || r === 'treeitem' || r === 'row' || r === 'listitem') {
      var txt = norm(e.innerText || e.textContent);
      if (!txt) { var img = e.querySelector('img[alt]'); if (img) txt = norm(img.getAttribute('alt')); }
      return txt || norm(e.getAttribute('title'));
    }
    return norm(e.getAttribute('title'));
  };
  var all = function () { return document.querySelectorAll('*'); };
  // How many visible elements a locator like Playwright's would find (substring, case-insensitive; or exact).
  var countBy = function (test) { var n = 0, a = all(); for (var i = 0; i < a.length && n < 3; i++) if (test(a[i]) && visible(a[i])) n++; return n; };
  var has = function (v, wanted, exact) { return exact ? norm(v) === wanted : lower(v).indexOf(wanted.toLowerCase()) >= 0; };
  // The project's locator policy (RECORDER_IGNORE_ID_PATTERN / RECORDER_IGNORE_CLASS_PATTERN), set by the Studio.
  var pol = { id: null, cls: null };
  var GENERATED_ID = /^(ember|react|mui|radix|headlessui|ext-gen)/i;
  var goodId = function (id) { return !!id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{4,}/.test(id) && !GENERATED_ID.test(id) && !(pol.id && pol.id.test(id)); };
  var CLICKABLE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=treeitem],[onclick],[contenteditable=""],[contenteditable=true]';
  var api = {
    target: function (el) {
      if (!el) return el;
      if (el.nodeType === 3) el = el.parentElement;
      var c = el.closest ? el.closest(CLICKABLE) : null;
      if (c && c.tagName === 'LABEL' && c.control) return c.control;
      // A row of a list box (<select size> / multiple): the list itself, chosen in the Studio.
      if (c && c.tagName === 'OPTION') { var sel = c.closest('select'); if (sel) return sel; }
      return c || el;
    },
    info: function (e) {
      var t = e.tagName, ty = (e.getAttribute('type') || '').toLowerCase();
      var o = { tag: t.toLowerCase(), type: ty, role: role(e), name: name(e).slice(0, 120), editable: editable(e), text: norm(e.innerText || e.textContent).slice(0, 500),
        value: 'value' in e && t !== 'BUTTON' ? String(e.value) : '', check: t === 'INPUT' && (ty === 'checkbox' || ty === 'radio'), checked: !!e.checked,
        select: t === 'SELECT', multiple: !!e.multiple, file: t === 'INPUT' && ty === 'file', password: t === 'INPUT' && ty === 'password', disabled: !!e.disabled };
      if (t === 'SELECT') o.options = Array.prototype.map.call(e.options, function (x) { return { value: x.value, label: norm(x.label || x.textContent), selected: x.selected }; });
      // Attributes a check can use (not styling, events or framework internals).
      o.attributes = Array.prototype.filter.call(e.attributes, function (a) { return !/^(style|class|tabindex|on\w+|data-v-\w+|_ngcontent.*|_nghost.*)$/.test(a.name); })
        .slice(0, 30).map(function (a) { return { name: a.name, value: String(a.value).slice(0, 200) }; });
      // A table cell: its row's key text and its column (header text and position).
      var cell = e.closest ? e.closest('td,th,[role=cell],[role=gridcell]') : null;
      var row = cell && cell.closest('tr,[role=row]');
      if (cell && row) {
        var cells = Array.prototype.filter.call(row.children, function (k) { return /^(TD|TH)$/.test(k.tagName) || /^(cell|gridcell|columnheader|rowheader)$/.test(k.getAttribute('role') || ''); });
        var col = cells.indexOf(cell);
        var key = '';
        for (var i = 0; i < cells.length && !key; i++) { var kt = norm(cells[i].innerText || cells[i].textContent); if (kt && kt.length <= 40 && i !== col) key = kt; }
        var table = row.closest('table,[role=table],[role=grid]');
        var header = '';
        if (table) {
          var hr = table.querySelector('thead tr, [role=row]:has([role=columnheader])');
          if (hr) { var hs = Array.prototype.filter.call(hr.children, function (k) { return /^(TD|TH)$/.test(k.tagName) || k.getAttribute('role') === 'columnheader'; }); if (hs[col]) header = norm(hs[col].innerText || hs[col].textContent); }
        }
        o.cell = { rowKey: key, col: col, header: header, text: norm(cell.innerText || cell.textContent).slice(0, 200), table: table ? api.css(table) : '' };
      }
      return o;
    },
    // Items like this one (rows of a table, entries of a list): the same kind of element in the same container.
    similar: function (e) {
      var item = e.closest ? (e.closest('tr,li,[role=row],[role=listitem],[role=option]') || e) : e;
      var parent = item.parentElement;
      if (!parent) return null;
      return api.css(parent) + ' > ' + api.tagClass(item);
    },
    candidates: function (e, testIdAttr) {
      var out = [];
      var add = function (m, a, u) { if (out.length < 16) out.push({ c: [{ m: m, a: a }], u: u }); };
      var addChain = function (c, u) { if (out.length < 16) out.push({ c: c, u: u }); };
      var tid = testIdAttr && e.getAttribute(testIdAttr);
      if (tid) add('getByTestId', [tid], countBy(function (x) { return x.getAttribute(testIdAttr) === tid; }) === 1);
      var r = role(e), n = name(e);
      if (r && r !== 'presentation' && n && n.length <= 100) {
        var c = countBy(function (x) { return role(x) === r && has(name(x), n); });
        add('getByRole', [r, { name: n }], c === 1);
        if (c !== 1) add('getByRole', [r, { name: n, exact: true }], countBy(function (x) { return role(x) === r && has(name(x), n, true); }) === 1);
      }
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName)) {
        var l = labelText(e) || norm(e.getAttribute('aria-label'));
        if (l && l.length <= 100) add('getByLabel', [l], countBy(function (x) { return /^(INPUT|SELECT|TEXTAREA)$/.test(x.tagName) && has(labelText(x) || x.getAttribute('aria-label'), l); }) === 1);
        var ph = norm(e.getAttribute('placeholder'));
        if (ph) add('getByPlaceholder', [ph], countBy(function (x) { return has(x.getAttribute('placeholder'), ph); }) === 1);
      }
      var alt = norm(e.getAttribute('alt'));
      if (alt) add('getByAltText', [alt], countBy(function (x) { return has(x.getAttribute('alt'), alt); }) === 1);
      var title = norm(e.getAttribute('title'));
      if (title && !n) add('getByTitle', [title], countBy(function (x) { return has(x.getAttribute('title'), title); }) === 1);
      var txt = norm(e.innerText || e.textContent);
      if (!r && txt && txt.length <= 80 && e.children.length <= 3) {
        var leaf = function (x) { return norm(x.innerText || x.textContent) && !Array.prototype.some.call(x.children, function (k) { return has(k.innerText || k.textContent, txt); }); };
        add('getByText', [txt], countBy(function (x) { return has(x.innerText || x.textContent, txt) && leaf(x); }) === 1);
        add('getByText', [txt, { exact: true }], countBy(function (x) { return norm(x.innerText || x.textContent) === txt && leaf(x); }) === 1);
      }
      if (r && r !== 'presentation') add('getByRole', [r], countBy(function (x) { return role(x) === r; }) === 1);
      var id = e.id;
      if (goodId(id)) add('locator', ['#' + id], true);
      // Inside the group with a label (a custom dropdown "-- Select --" under "User Role"): how a person
      // describes it when the element itself has no name of its own.
      var inner = txt && txt.length <= 60 ? { m: 'getByText', a: [txt] } : { m: 'locator', a: [api.tagClass(e)] };
      for (var anc = e.parentElement, lvl = 0; anc && anc !== document.body && lvl < 6; anc = anc.parentElement, lvl++) {
        var lab = api.groupLabel(anc, e);
        if (!lab) continue;
        addChain([{ m: 'locator', a: [api.tagClass(anc)] }, { m: 'filter', a: [{ hasText: lab }] }, inner], false);
        break;
      }
      // The n-th of several alike (checked by Playwright when recorded; reported as positional).
      if (txt && txt.length <= 60) {
        var same = []; var a2 = all();
        for (var i2 = 0; i2 < a2.length; i2++) if (visible(a2[i2]) && norm(a2[i2].innerText || a2[i2].textContent) === txt && !Array.prototype.some.call(a2[i2].children, function (k) { return norm(k.innerText || k.textContent) === txt; })) same.push(a2[i2]);
        var k = same.indexOf(e);
        if (same.length > 1 && k >= 0) addChain([{ m: 'getByText', a: [txt, { exact: true }] }, { m: 'nth', a: [k] }], false);
      }
      add('locator', [api.css(e)], false);
      return out;
    },
    // A tag with its first meaningful class (not generated, not a state).
    tagClass: function (e) {
      var tag = e.tagName.toLowerCase();
      var cls = Array.prototype.filter.call(e.classList || [], function (c) { return /^[A-Za-z][\w-]{2,}$/.test(c) && !/\d{3,}|^(css|sc|jss|emotion|ng|v)-|active|focus|hover|open|selected|disabled|ng-|--/.test(c) && !(pol.cls && pol.cls.test(c)); });
      return cls.length ? tag + '.' + cls[0] : tag;
    },
    // The label of a group (label, legend, heading, a "label"/"title" element) that is not the element itself.
    groupLabel: function (anc, e) {
      var c = anc.querySelectorAll('label,legend,h1,h2,h3,h4,h5,h6,th,dt,[class*="label" i],[class*="title" i]');
      for (var i = 0; i < c.length; i++) {
        var x = c[i];
        if (x === e || x.contains(e) || e.contains(x)) continue;
        var t = norm(x.innerText || x.textContent);
        if (t && t.length <= 40) return t;
      }
      return '';
    },
    // A CSS path from the nearest element with a stable id (positions only where needed).
    css: function (e) {
      var parts = [];
      for (var x = e; x && x.nodeType === 1 && x !== document.documentElement; x = x.parentElement) {
        if (goodId(x.id)) { parts.unshift('#' + x.id); break; }
        var t = x.tagName.toLowerCase(), p = x.parentElement;
        if (p) {
          var same = Array.prototype.filter.call(p.children, function (k) { return k.tagName === x.tagName; });
          if (same.length > 1) t += ':nth-of-type(' + (same.indexOf(x) + 1) + ')';
        }
        parts.unshift(t);
        if (parts.length >= 12) break;
      }
      if (parts[0] && parts[0].charAt(0) !== '#') parts.unshift('body');
      return parts.join(' > ');
    },
    frameCandidates: function (e) {
      var out = [], nm = e.getAttribute('name'), title = e.getAttribute('title'), tag = e.tagName.toLowerCase();
      if (nm) out.push(tag + '[name="' + nm.replace(/"/g, '\\"') + '"]');
      if (goodId(e.id)) out.push('#' + e.id);
      if (title) out.push(tag + '[title="' + title.replace(/"/g, '\\"') + '"]');
      out.push(api.css(e));
      return out;
    }
  };
  // What the page shows, before an action and after it: the checks a tester would add for what changed.
  // Elements with their own text (a message, a heading, a counter) and the ones that announce (alert, status,
  // dialog, toast); kept in this document only (a new document after a navigation has none).
  var before = null, changed = [];
  var MSG = /toast|alert|message|notif|error|success|warning|banner|snackbar|feedback|validation/i;
  var ownText = function (e) { for (var c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && norm(c.textContent)) return true; return false; };
  var announces = function (e) {
    var r = role(e);
    if (/^(alert|status|alertdialog|dialog|log)$/.test(r) || e.getAttribute('aria-live') === 'assertive' || e.getAttribute('aria-live') === 'polite') return true;
    var c = typeof e.className === 'string' ? e.className : '';
    return MSG.test(c) || MSG.test(e.id || '');
  };
  var shown = function () {
    var m = new Map(), a = document.querySelectorAll('body *'), n = 0;
    for (var i = 0; i < a.length && n < 3000; i++) {
      var e = a[i];
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|svg|path)$/.test(e.tagName)) continue;
      var ann = announces(e);
      if (!ann && !ownText(e)) continue;
      if (!visible(e)) continue;
      var t = norm(e.innerText || e.textContent);
      if (!t || t.length > 300) continue;
      m.set(e, { t: t, a: ann, h: role(e) === 'heading' });
      n++;
    }
    return m;
  };
  api.snapBefore = function () { before = shown(); changed = []; return before.size; };
  api.snapDiff = function () {
    var now = shown(), out = [], fresh = !before;
    // A new document (the action opened another page): everything on it appeared.
    if (fresh) before = new Map();
    now.forEach(function (v, e) {
      var was = before.get(e);
      if (was && was.t === v.t) return;
      var near = false;
      for (var p = e.parentElement; p && !near; p = p.parentElement) near = announces(p);
      changed.push(e);
      out.push({ i: changed.length - 1, how: was ? 'changed' : 'appeared', text: v.t, was: was ? was.t : '', announces: v.a || near, heading: v.h, tag: e.tagName.toLowerCase() });
    });
    before.forEach(function (v, e) {
      if (now.has(e)) return;
      if (!v.a) return;
      out.push({ i: -1, how: 'gone', text: v.t, was: v.t, announces: true, heading: v.h, tag: e.tagName.toLowerCase() });
    });
    before = null;
    return { fresh: fresh, items: out.slice(0, 200) };
  };
  api.snapEl = function (i) { return changed[i] || null; };
  // The policy (regular expression sources; one that does not read is not used).
  api.policy = function (id, cls) {
    try { pol.id = id ? new RegExp(id) : null; } catch (x) { pol.id = null; }
    try { pol.cls = cls ? new RegExp(cls) : null; } catch (x) { pol.cls = null; }
  };
  Object.defineProperty(window, '__csRec', { value: api, enumerable: false });
})();`;
