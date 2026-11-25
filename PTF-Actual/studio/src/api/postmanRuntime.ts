/**
 * The Studio's checks as Postman test scripts (collection export): a small runtime goes in front of a request's
 * tests (the Studio's own JsonPath class, and the same value reading and comparisons as checks.ts), so a rule check
 * gives the same verdict in Postman / Newman as in the Studio. A test (apiExport.test.ts) runs this runtime in a
 * sandbox next to checks.ts on the same cases.
 *
 * Every exported check and saved value is wrapped in marker comments (cs-studio:check / cs-studio:save … end):
 * Postman runs the script between them; the Studio's import reads the marker back exactly.
 */
import { JsonPath } from './jsonPath';
import type { ApiCheck, ApiExtract, Expected } from './model';
import { valueRef } from './feature';

const js = (s: unknown) => JSON.stringify(s);

/** The runtime (ES2017, the Postman sandbox), defining `cs` with value(ref), check(), same(), pathValue(), xmlValue(). */
export function runtimeSource(): string {
    return `// cs-studio:runtime (the Studio's check rules; generated, do not edit)
var cs = (function () {
// (a no-op helper some builds keep in the class text)
var __name = function (f) { return f; };
var JsonPath = ${JsonPath.toString()};
function num(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || typeof v === 'boolean' || v instanceof Date) return null;
    var s = String(v).trim();
    return s !== '' && !isNaN(Number(s)) ? Number(s) : null;
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function day(v) {
    var s = String(v === undefined || v === null ? '' : v).trim();
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    var t = Date.parse(s);
    return isNaN(t) ? null : ymd(new Date(t));
}
function moment(v) {
    if (typeof v !== 'string' || !/\\d{4}-\\d{2}-\\d{2}/.test(v)) return null;
    var t = Date.parse(v.trim().replace(' ', 'T'));
    return isNaN(t) ? null : t;
}
function jsn(s) { try { return JSON.parse(s); } catch (e) { return s; } }
function show(v) { return v === undefined ? '(missing)' : JSON.stringify(v); }
function same(actual, expected, o) {
    o = o || {};
    var mode = o.compare || 'auto';
    if (actual === undefined) return false;
    if (mode === 'number') { var a1 = num(actual), b1 = num(expected); return a1 !== null && b1 !== null && Math.abs(a1 - b1) <= (o.tolerance === undefined ? 0.0001 : o.tolerance) + 1e-12; }
    if (mode === 'date') { var a2 = day(actual), b2 = day(expected); return a2 !== null && a2 === b2; }
    if (mode === 'datetime') { var a3 = moment(actual), b3 = moment(expected); return a3 !== null && a3 === b3; }
    if (mode === 'auto') {
        if (actual === null || expected === null) return actual === expected || String(actual) === String(expected);
        if (typeof actual === 'boolean' || typeof expected === 'boolean') return String(actual) === String(expected);
        var a = num(actual), b = num(expected);
        if (a !== null && b !== null) return Math.abs(a - b) <= (o.tolerance || 0) + 1e-12;
        if (typeof actual === 'object' || typeof expected === 'object') return JSON.stringify(actual) === JSON.stringify(typeof expected === 'string' ? jsn(expected) : expected);
    }
    var x = String(actual), y = String(expected);
    return o.ignoreCase ? x.toLowerCase() === y.toLowerCase() : x === y;
}
function pathValue(data, path) {
    try {
        var q = JsonPath.query(data, path);
        if (!q.multi) return q.values.length ? q.values[0] : undefined;
        return q.values.length === 1 ? q.values[0] : q.values.length ? q.values : undefined;
    } catch (e) { return undefined; }
}
function xmlValue(text, path) {
    var root = { name: '#document', attrs: {}, children: [], text: '' };
    var stack = [root];
    var re = /<!--[\\s\\S]*?-->|<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|<\\?[\\s\\S]*?\\?>|<!DOCTYPE[^>]*>|<\\/\\s*([\\w:.-]+)\\s*>|<([\\w:.-]+)((?:\\s+[\\w:.-]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(\\/?)>|([^<]+)/g;
    var decode = function (s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); };
    var m;
    while ((m = re.exec(text))) {
        var top = stack[stack.length - 1];
        if (m[1] !== undefined) top.text += m[1];
        else if (m[2]) { if (stack.length > 1) stack.pop(); }
        else if (m[3]) {
            var attrs = {}, am, are = /([\\w:.-]+)\\s*=\\s*(?:"([^"]*)"|'([^']*)')/g;
            while ((am = are.exec(m[4] || ''))) attrs[am[1]] = decode(am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : '');
            var el = { name: m[3], attrs: attrs, children: [], text: '' };
            top.children.push(el);
            if (!m[5]) stack.push(el);
        } else if (m[6] !== undefined) top.text += decode(m[6]);
    }
    var all = function (e) { return e.text + e.children.map(all).join(''); };
    var descendants = function (e) { return e.children.reduce(function (acc, c) { return acc.concat([c], descendants(c)); }, []); };
    var nodes = [root];
    var parts = path.trim().replace(/^\\/\\//, '/§/').split('/').filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i], deep = false;
        if (part === '§') { deep = true; part = parts[++i]; }
        if (part.charAt(0) === '@') { var at = part.slice(1); var found = nodes.map(function (n) { return n.attrs[at]; }).filter(function (x) { return x !== undefined; }); return found[0]; }
        var pm2 = /^([\\w:.*-]+)(?:\\[(\\d+)\\])?$/.exec(part);
        if (!pm2) throw new Error('Unsupported XML path part "' + part + '" in ' + path);
        var pick = function (list) { return list.filter(function (c) { return pm2[1] === '*' || c.name === pm2[1] || c.name.slice(-(pm2[1].length + 1)) === ':' + pm2[1]; }); };
        nodes = nodes.reduce(function (acc, n) { var f = pick(deep ? descendants(n) : n.children); return acc.concat(pm2[2] ? (f[Number(pm2[2]) - 1] ? [f[Number(pm2[2]) - 1]] : []) : f); }, []);
    }
    return nodes.length ? all(nodes[0]).trim() : undefined;
}
function cookies() {
    return pm.response.headers.all().filter(function (h) { return h.key.toLowerCase() === 'set-cookie'; }).map(function (h) {
        var nv = h.value.split(';')[0], i = nv.indexOf('=');
        return { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim() };
    });
}
function value(ref) {
    var s = ref.trim();
    if (s.charAt(0) === '$') { var body; try { body = pm.response.json(); } catch (e) { body = jsn(pm.response.text()); } return pathValue(body, s); }
    var at = s.indexOf(':');
    var kind = (at < 0 ? s : s.slice(0, at)).trim().toLowerCase(), name = at < 0 ? '' : s.slice(at + 1).trim();
    switch (kind) {
        case 'status': return pm.response.code;
        case 'time': return pm.response.responseTime;
        case 'size': return pm.response.responseSize;
        case 'body': return pm.response.text();
        case 'header': { var hv = pm.response.headers.get(name); return hv === null ? undefined : hv; }
        case 'cookie': { var c = cookies().filter(function (x) { return x.name === name; })[0]; return c ? c.value : undefined; }
        case 'xml': return xmlValue(pm.response.text(), name);
    }
    throw new Error('Unknown value reference "' + ref + '"');
}
function check(ref, actual, op, exp, o) {
    o = o || {};
    var text = actual === undefined || actual === null ? '' : typeof actual === 'string' ? actual : JSON.stringify(actual);
    var ic = function (s) { return o.ignoreCase ? s.toLowerCase() : s; };
    var n = function (v) { var x = num(v); if (x === null) throw new Error(show(v) + ' is not a number'); return x; };
    var order = function (v) { return (o.compare === 'date' || o.compare === 'datetime' || (o.compare === undefined && moment(v) !== null && num(v) === null)) ? (moment(v) !== null ? moment(v) : n(v)) : n(v); };
    var empty = actual === undefined || actual === null || (Array.isArray(actual) ? actual.length === 0 : typeof actual === 'object' ? Object.keys(actual).length === 0 : String(actual).trim() === '');
    var e = typeof exp === 'string' ? exp : String(exp === undefined || exp === null ? '' : exp);
    var has = function () { return Array.isArray(actual) ? actual.some(function (x) { return same(x, exp, o); }) : ic(text).indexOf(ic(e)) >= 0; };
    var pass, wanted;
    try {
        switch (op) {
            case 'equals': pass = same(actual, exp, o); wanted = 'to be ' + show(exp); break;
            case 'notEquals': pass = actual !== undefined && !same(actual, exp, o); wanted = 'not to be ' + show(exp); break;
            case 'contains': pass = actual !== undefined && has(); wanted = 'to contain ' + show(exp); break;
            case 'notContains': pass = actual !== undefined && !has(); wanted = 'not to contain ' + show(exp); break;
            case 'matches': pass = actual !== undefined && new RegExp(e, o.ignoreCase ? 'i' : '').test(text); wanted = 'to match /' + e + '/'; break;
            case 'exists': pass = actual !== undefined; wanted = 'to exist'; break;
            case 'notExists': pass = actual === undefined; wanted = 'not to exist'; break;
            case 'empty': pass = empty; wanted = 'to be empty'; break;
            case 'notEmpty': pass = !empty; wanted = 'not to be empty'; break;
            case 'type': { var t = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual; pass = t === e.toLowerCase(); wanted = 'to be of type ' + e; break; }
            case 'count': { var cnt = Array.isArray(actual) ? actual.length : actual === undefined ? 0 : 1; pass = cnt === n(exp); wanted = 'to have ' + e + ' item(s) (has ' + cnt + ')'; break; }
            case 'greater': pass = actual !== undefined && order(actual) > order(exp); wanted = 'to be greater than ' + e; break;
            case 'less': pass = actual !== undefined && order(actual) < order(exp); wanted = 'to be less than ' + e; break;
            case 'atLeast': pass = actual !== undefined && order(actual) >= order(exp); wanted = 'to be at least ' + e; break;
            case 'atMost': pass = actual !== undefined && order(actual) <= order(exp); wanted = 'to be at most ' + e; break;
            case 'between': pass = actual !== undefined && order(actual) >= order(exp) && order(actual) <= order(o.to); wanted = 'to be between ' + e + ' and ' + String(o.to); break;
            case 'oneOf': { var opts = e.split(',').map(function (x) { return x.trim(); }); pass = actual !== undefined && opts.some(function (x) { return same(actual, x, o); }); wanted = 'to be one of ' + opts.join(', '); break; }
            default: return { pass: false, message: 'Unknown operator ' + op };
        }
    } catch (err) { return { pass: false, message: ref + ': ' + err.message }; }
    return { pass: pass, message: pass ? ref + ' ' + op + ' ' + show(exp) : ref + ' was expected ' + wanted + ', but was ' + show(actual) };
}
function text(v) { return v === undefined || v === null ? '' : String(v); }
return { value: value, check: check, same: same, pathValue: pathValue, xmlValue: xmlValue, text: text };
})();
// cs-studio:end`;
}

/** An expected value in Postman: a text (with {{name}} / data columns filled by Postman), a saved value, a data column, a setting. */
function expectedJs(e: Expected | undefined): string {
    if (!e) return "''";
    const v = e.value.trim();
    switch (e.from) {
        case 'saved': return `cs.text(pm.variables.get(${js(v)}))`;
        case 'data': return `cs.text(pm.iterationData.get(${js(v)}))`;
        case 'config': return `cs.text(pm.variables.get(${js(v)}))`;
        default: return `pm.variables.replaceIn(${js(e.value.replace(/<([\w .-]+)>/g, '{{$1}}').replace(/\{(?:env|config):([\w.-]+)\}/g, '{{$1}}'))})`;
    }
}

const block = (marker: string, payload: unknown, name: string, ...body: string[]) =>
    [`// cs-studio:${marker} ${js(payload)}`, `pm.test(${js(name)}, function () {`, ...body.map((l) => `    ${l}`), '});', '// cs-studio:end'];

/**
 * A rule, schema or database check as a marked test. Database checks and expected values from a database query
 * cannot run in Postman: the test is a skipped one saying so (and the export lists it).
 */
export function extraCheckScript(c: ApiCheck, schemaText?: string): { lines: string[]; warning?: string } {
    if (c.kind === 'rule') {
        const ref = valueRef(c);
        const name = `${ref} ${c.op ?? 'equals'}${c.expected ? ` ${c.expected.value}` : ''}`;
        if (c.expected?.from === 'query' || c.expected2?.from === 'query') {
            return { lines: [`// cs-studio:check ${js(c)}`, `pm.test.skip(${js(`${name} (needs the database: run it in the Studio or the framework)`)}, function () {});`, '// cs-studio:end'], warning: `${name}: compares with a database query, which Postman cannot run (kept as a skipped test).` };
        }
        const opts = `{ compare: ${js(c.compare && c.compare !== 'text' ? c.compare : c.compare === 'text' ? 'text' : undefined)}, tolerance: ${js(c.tolerance)}, ignoreCase: ${js(!!c.ignoreCase)}${c.expected2 ? `, to: ${expectedJs(c.expected2)}` : ''} }`;
        return { lines: block('check', c, name, `var r = cs.check(${js(ref)}, cs.value(${js(ref)}), ${js(c.op ?? 'equals')}, ${expectedJs(c.expected)}, ${opts});`, 'pm.expect(r.pass, r.message).to.be.true;') };
    }
    if (c.kind === 'schema') {
        const text = c.schemaFile?.trim() ? schemaText : c.schema;
        if (!text) return { lines: [`// cs-studio:check ${js(c)}`, `pm.test.skip(${js(`Schema ${c.schemaFile} (the file was not found when exporting)`)}, function () {});`, '// cs-studio:end'], warning: `Schema file ${c.schemaFile} was not found: kept as a skipped test.` };
        let schema: unknown;
        try { schema = JSON.parse(text); } catch { return { lines: [], warning: 'A schema check whose schema is not valid JSON was left out.' }; }
        return { lines: block('check', c, `The body matches the schema${c.schemaFile ? ` ${c.schemaFile}` : ''}`, `pm.response.to.have.jsonSchema(${js(schema)});`) };
    }
    if (c.kind === 'dbItems') {
        return { lines: [`// cs-studio:check ${js(c)}`, `pm.test.skip(${js(`Each item matches the database query ${c.db?.query ?? ''} (needs the database: run it in the Studio or the framework)`)}, function () {});`, '// cs-studio:end'], warning: `A database check (${c.db?.query ?? 'query'}) cannot run in Postman: kept as a skipped test.` };
    }
    return { lines: [] };
}

/** A saved value as marked script: from a JSON path, header, cookie, XML path, status, body or regex (same reading as the Studio). */
export function saveScript(e: ApiExtract): string[] {
    const set = (expr: string) => `pm.collectionVariables.set(${js(e.variable)}, ${expr});`;
    let expr: string;
    switch (e.from) {
        case 'header': expr = `cs.text(cs.value(${js(`header:${e.path}`)}))`; break;
        case 'cookie': expr = `cs.text(cs.value(${js(`cookie:${e.path}`)}))`; break;
        case 'xml': expr = `cs.text(cs.value(${js(`xml:${e.path}`)}))`; break;
        case 'status': expr = 'String(pm.response.code)'; break;
        case 'body': expr = 'pm.response.text()'; break;
        case 'regex': expr = `(function () { var m = new RegExp(${js(e.path)}).exec(pm.response.text()); return m ? (m[1] !== undefined ? m[1] : m[0]) : ''; })()`; break;
        default: expr = `(function () { var v = cs.value(${js(e.path || '$')}); return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v); })()`;
    }
    return [`// cs-studio:save ${js(e)}`, set(expr), '// cs-studio:end'];
}
