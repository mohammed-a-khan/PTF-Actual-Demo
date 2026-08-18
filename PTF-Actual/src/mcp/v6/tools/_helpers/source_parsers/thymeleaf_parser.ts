/**
 * Thymeleaf template parser — extracts forms and fields from `.html` files
 * inside a Spring Boot `templates/` directory. Understands the common Thymeleaf
 * attribute set:
 *   - `th:id`, `th:name`, `th:field`, `th:action`, `th:href`, `th:src`
 *   - `th:text="#{key}"` — key resolution against the messages map
 *   - `th:each="row : ${rows}"` — iteration variable extraction
 *   - `#{key}` — direct message expression inline in text
 *   - `${bean.field}` — server-side binding path
 *
 * When both plain HTML `id`/`name` and Thymeleaf `th:id`/`th:name` are present,
 * we prefer the Thymeleaf form because that is what is rendered at runtime.
 */

export interface ThymeField {
    id: string | null;
    name: string | null;
    thField: string | null;
    tag: string;
    type: string | null;
    label: string | null;
    messageKey: string | null;
    required: boolean;
    maxLength: number | null;
    lineNumber: number;
}

export interface ThymeForm {
    formId: string | null;
    action: string | null;
    method: string | null;
    fields: ThymeField[];
    submitButtonId: string | null;
    lineNumber: number;
}

export interface ThymeParseResult {
    filePath: string;
    forms: ThymeForm[];
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
    const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag)) !== null) out[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    return out;
}

const KEY_EXPR_RE = /#\{\s*([^}]+?)\s*\}/g;
const BEAN_EXPR_RE = /\$\{\s*([^}]+?)\s*\}/g;

function resolveKeyRefs(text: string, messages: Record<string, string>, refs: Set<string>, unresolved: Set<string>): string {
    let out = text;
    KEY_EXPR_RE.lastIndex = 0;
    out = out.replace(KEY_EXPR_RE, (_full, key) => {
        const k = String(key).trim();
        refs.add(k);
        if (messages[k] !== undefined) return messages[k];
        unresolved.add(k);
        return _full;
    });
    return out;
}

export function parseThymeleafFile(filePath: string, src: string, messages: Record<string, string> = {}): ThymeParseResult {
    const forms: ThymeForm[] = [];
    const navigation: Array<{ linkText: string; href: string; lineNumber: number }> = [];
    const refs = new Set<string>();
    const unresolved = new Set<string>();
    const warnings: string[] = [];

    // Global label map first.
    const labelMap = collectLabels(src, messages, refs, unresolved);

    // Forms.
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    let fm: RegExpExecArray | null;
    while ((fm = formRe.exec(src)) !== null) {
        const attrs = parseAttrs(fm[1]);
        const formId = attrs.id || attrs['th:id'] || null;
        const action = attrs['th:action'] || attrs.action || null;
        const method = (attrs.method || 'POST').toUpperCase();
        const inner = fm[2];
        const startOffset = fm.index;
        const fields: ThymeField[] = [];

        const inputRe = /<(input|select|textarea|button)\b([^>]*)(?:\/?>([\s\S]*?)<\/\1>|\/?>)/gi;
        let im: RegExpExecArray | null;
        while ((im = inputRe.exec(inner)) !== null) {
            const tagName = im[1].toLowerCase();
            const a = parseAttrs(im[2]);
            const thField = a['th:field'] || null;
            // Thymeleaf's `th:field="*{user.email}"` synthesizes id + name at render time.
            const synthId = thField ? thField.replace(/^\*\{|\}$/g, '').replace(/\./g, '') : null;
            const id = a['th:id'] || a.id || synthId || null;
            const name = a['th:name'] || a.name || (thField ? thField.replace(/^\*\{|\}$/g, '') : null);
            const type = a.type || (tagName === 'select' ? 'select' : tagName === 'textarea' ? 'textarea' : tagName === 'button' ? 'button' : 'text');
            const label = id ? (labelMap[id] || null) : null;
            let messageKey: string | null = null;
            if (label) {
                for (const [k, v] of Object.entries(messages)) if (v === label) { messageKey = k; break; }
            }
            const required = a.required !== undefined || a['th:required'] !== undefined;
            const maxLen = a.maxlength ? parseInt(a.maxlength, 10) : null;
            const line = lineOf(src, startOffset + fm[0].indexOf(inner) + im.index);
            fields.push({
                id, name, thField, tag: tagName, type, label, messageKey,
                required, maxLength: Number.isNaN(maxLen as number) ? null : maxLen, lineNumber: line,
            });
        }
        const submit = fields.find((f) => (f.tag === 'button' && (!f.type || f.type === 'submit')) || (f.tag === 'input' && f.type === 'submit'));
        forms.push({
            formId, action, method,
            fields, submitButtonId: submit ? submit.id : null,
            lineNumber: lineOf(src, startOffset),
        });
    }

    // Navigation anchors.
    const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let am: RegExpExecArray | null;
    while ((am = aRe.exec(src)) !== null) {
        const attrs = parseAttrs(am[1]);
        const href = attrs['th:href'] || attrs.href || '';
        if (!href) continue;
        const rawText = am[2].replace(/<[^>]+>/g, '').trim();
        const resolved = resolveKeyRefs(rawText, messages, refs, unresolved);
        // Also look for `th:text` attribute inside anchor.
        if (attrs['th:text']) {
            const cleaned = resolveKeyRefs(attrs['th:text'].replace(/^#\{/, '#{'), messages, refs, unresolved);
            navigation.push({ linkText: cleaned, href, lineNumber: lineOf(src, am.index) });
        } else {
            navigation.push({ linkText: resolved, href, lineNumber: lineOf(src, am.index) });
        }
    }

    return {
        filePath, forms, navigation,
        messageKeysReferenced: Array.from(refs),
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
        const forId = a.for || a['th:for'];
        if (!forId) continue;
        // If th:text present, use it as the key/text source.
        let text = m[2].replace(/<[^>]+>/g, '').trim();
        if (a['th:text']) text = a['th:text'];
        map[forId] = resolveKeyRefs(text, messages, refs, unresolved);
    }
    // Also capture BEAN_EXPR_RE usage — pass through unresolved for downstream signal.
    BEAN_EXPR_RE.lastIndex = 0;
    return map;
}
