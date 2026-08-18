/**
 * JSP parser — extracts forms, inputs, buttons, tables, links, and resolves
 * Spring `<spring:message code="..."/>` and JSTL `<fmt:message key="..."/>`
 * against a messages map. Tolerant to arbitrary custom tag libraries: any
 * `<foo:bar>` we don't understand is passed through opaque.
 *
 * We intentionally avoid a full HTML/XML parser — JSP is not well-formed XML in
 * practice (scriptlets, expression language, unclosed tags). Regex extraction
 * with attribute-aware tokenization gives us the identifiers we need.
 */

export interface JspFormField {
    id: string | null;
    name: string | null;
    path: string | null; // Spring form:input path=...
    tag: string; // input / select / textarea / button
    type: string | null;
    label: string | null;
    messageKey: string | null;
    required: boolean;
    maxLength: number | null;
    pattern: string | null;
    lineNumber: number;
}

export interface JspForm {
    formId: string | null;
    action: string | null;
    method: string | null;
    fields: JspFormField[];
    submitButtonId: string | null;
    tables: Array<{ id: string | null; columns: Array<{ header: string; boundField: string | null }> }>;
    lineNumber: number;
}

export interface JspParseResult {
    filePath: string;
    forms: JspForm[];
    navigation: Array<{ linkText: string; href: string; lineNumber: number }>;
    messageKeysReferenced: string[];
    unresolvedMessageKeys: string[];
    warnings: string[];
}

function lineOf(src: string, offset: number): number {
    let ln = 1;
    for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') ln++;
    return ln;
}

function parseAttrs(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    // Attribute forms: name="value", name='value', name=value (bareword).
    const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag)) !== null) {
        out[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    }
    return out;
}

const MSG_TAG_RE = /<(?:spring|s|fmt|c):(?:message|out)[^>]*(?:code|key|value)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*\/?\s*>/g;
const EL_MSG_RE = /\$\{\s*(?:messages|text|labels)\s*\[\s*['"]([^'"]+)['"]\s*\]\s*\}/g;
const EL_MSG_KEY_RE = /\$\{\s*[a-zA-Z_][\w]*Messages?\.([a-zA-Z_][\w.]*)\s*\}/g;

function resolveMessageInline(text: string, messages: Record<string, string>): { value: string; keys: string[]; unresolved: string[] } {
    let out = text;
    const keys: string[] = [];
    const unresolved: string[] = [];
    // Replace all recognized message references with their literal.
    const resolvers = [MSG_TAG_RE, EL_MSG_RE, EL_MSG_KEY_RE];
    for (const re of resolvers) {
        re.lastIndex = 0;
        out = out.replace(re, (_full, key) => {
            keys.push(key);
            if (messages[key] !== undefined) return messages[key];
            unresolved.push(key);
            return _full; // leave the ref if unresolved
        });
    }
    return { value: out.trim(), keys, unresolved };
}

/**
 * Parse a JSP source. `messages` maps `code` → literal. Pass an empty object if
 * you only care about which keys are referenced.
 */
export function parseJspFile(filePath: string, src: string, messages: Record<string, string> = {}): JspParseResult {
    const forms: JspForm[] = [];
    const navigation: Array<{ linkText: string; href: string; lineNumber: number }> = [];
    const referencedKeys = new Set<string>();
    const unresolved = new Set<string>();
    const warnings: string[] = [];

    // Collect a global label map first — <label for="id">text</label>.
    const labelMap = collectLabels(src, messages, referencedKeys, unresolved);

    // Find each <form> ... </form> (or <form:form ...> ... </form:form>).
    const formRe = /<(form(?::form)?)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let fm: RegExpExecArray | null;
    while ((fm = formRe.exec(src)) !== null) {
        const attrs = parseAttrs(fm[2]);
        const formId = attrs.id || attrs.name || null;
        const action = attrs.action || attrs.modelAttribute || null;
        const method = (attrs.method || 'POST').toUpperCase();
        const inner = fm[3];
        const startOffset = fm.index;
        const fields: JspFormField[] = [];

        // input / spring:input / form:input.
        const inputRe = /<(?:(?:spring:|form:))?(input|select|textarea|button)\b([^>]*)(?:\/?>([\s\S]*?)<\/(?:(?:spring:|form:))?\1>|\/?>)/gi;
        let im: RegExpExecArray | null;
        while ((im = inputRe.exec(inner)) !== null) {
            const tagName = im[1].toLowerCase();
            const a = parseAttrs(im[2]);
            const inputPath = a.path || null;
            const id = a.id || (inputPath ? inputPath + '1' : null); // Spring form:checkbox convention appends '1'
            const name = a.name || inputPath;
            const type = a.type || (tagName === 'select' ? 'select' : (tagName === 'textarea' ? 'textarea' : (tagName === 'button' ? 'button' : 'text')));
            const label = id ? (labelMap[id] || null) : null;
            const required = a.required !== undefined || /class="[^"]*\brequired\b/.test(im[2] || '');
            const maxLen = a.maxlength ? parseInt(a.maxlength, 10) : null;
            const pattern = a.pattern || null;
            const relOffset = im.index;
            const line = lineOf(src, startOffset + fm[0].indexOf(inner) + relOffset);
            // Resolve label from inline element if button has body text.
            let messageKey: string | null = null;
            if (label) {
                // The label may itself have been a message ref; that resolution happens in collectLabels.
                for (const [k, v] of Object.entries(messages)) if (v === label) { messageKey = k; break; }
            }
            fields.push({
                id, name, path: inputPath, tag: tagName, type,
                label, messageKey, required, maxLength: Number.isNaN(maxLen as number) ? null : maxLen,
                pattern, lineNumber: line,
            });
        }

        // Submit button — first input[type=submit] or button[type=submit].
        const submit = fields.find((f) => (f.tag === 'input' && (f.type === 'submit' || f.type === 'image')) || (f.tag === 'button' && (f.type === 'submit' || !f.type)));
        const submitButtonId = submit ? submit.id : null;

        // Tables inside the form.
        const tables: JspForm['tables'] = [];
        const tblRe = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
        let tm: RegExpExecArray | null;
        while ((tm = tblRe.exec(inner)) !== null) {
            const tAttrs = parseAttrs(tm[1]);
            const cols: Array<{ header: string; boundField: string | null }> = [];
            const thRe = /<th\b([^>]*)>([\s\S]*?)<\/th>/gi;
            let thm: RegExpExecArray | null;
            while ((thm = thRe.exec(tm[2])) !== null) {
                const rawText = thm[2].replace(/<[^>]+>/g, '').trim();
                const resolved = resolveMessageInline(rawText, messages);
                for (const k of resolved.keys) referencedKeys.add(k);
                for (const u of resolved.unresolved) unresolved.add(u);
                cols.push({ header: resolved.value, boundField: null });
            }
            // Bound fields: look for `<c:forEach var="row" ...>` + expression usage.
            const boundRe = /\$\{\s*[a-zA-Z_][\w]*\.([a-zA-Z_][\w.]*)\s*\}/g;
            let bmm: RegExpExecArray | null;
            const bound: string[] = [];
            while ((bmm = boundRe.exec(tm[2])) !== null) if (!bound.includes(bmm[1])) bound.push(bmm[1]);
            for (let ci = 0; ci < cols.length; ci++) cols[ci].boundField = bound[ci] || null;
            tables.push({ id: tAttrs.id || null, columns: cols });
        }

        forms.push({
            formId, action, method,
            fields, submitButtonId, tables,
            lineNumber: lineOf(src, startOffset),
        });
    }

    // Navigation — anchors outside forms.
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let am: RegExpExecArray | null;
    while ((am = anchorRe.exec(src)) !== null) {
        const attrs = parseAttrs(am[1]);
        const href = attrs.href || attrs.action || '';
        if (!href) continue;
        const rawText = am[2].replace(/<[^>]+>/g, '').trim();
        const resolved = resolveMessageInline(rawText, messages);
        for (const k of resolved.keys) referencedKeys.add(k);
        for (const u of resolved.unresolved) unresolved.add(u);
        navigation.push({
            linkText: resolved.value,
            href,
            lineNumber: lineOf(src, am.index),
        });
    }

    if (forms.length === 0 && navigation.length === 0 && src.length > 200) {
        // Not an error — the JSP may be a fragment/include.
    }

    return {
        filePath,
        forms,
        navigation,
        messageKeysReferenced: Array.from(referencedKeys),
        unresolvedMessageKeys: Array.from(unresolved),
        warnings,
    };
}

function collectLabels(src: string, messages: Record<string, string>, refs: Set<string>, unresolved: Set<string>): Record<string, string> {
    const map: Record<string, string> = {};
    const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const a = parseAttrs(m[1]);
        const forId = a.for || a.path;
        if (!forId) continue;
        // Resolve <spring:message> / <fmt:message> BEFORE stripping HTML tags
        // (the resolver rewrites tag-form message references to their literal;
        // the strip removes any remaining passthrough markup like <b>).
        const resolvedFirst = resolveMessageInline(m[2], messages);
        for (const k of resolvedFirst.keys) refs.add(k);
        for (const u of resolvedFirst.unresolved) unresolved.add(u);
        const stripped = resolvedFirst.value.replace(/<[^>]+>/g, '').trim();
        map[forId] = stripped;
    }
    return map;
}
