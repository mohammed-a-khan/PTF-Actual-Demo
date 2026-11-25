/** A recorded Playwright line in plain words, for the live list of steps (pure: unit-tested). */
const unq = (s: string) => s.replace(/\\(.)/g, '$1');

/** The element a locator names: button "Sign in", field "Username", [country]… */
export function targetWords(code: string): string {
    const inFrame = /contentFrame\(\)/.test(code);
    const last = code.replace(/^.*contentFrame\(\)/, 'page');
    let m: RegExpExecArray | null;
    // A table cell by its row and column.
    const cell = /getByRole\('row', \{ name: '((?:[^'\\]|\\.)*)'[^}]*\}\)\.locator\(':scope > \*'\)\.nth\((\d+)\)$/.exec(last);
    if (cell) return `cell ${Number(cell[2]) + 1} of row "${unq(cell[1])}"${inFrame ? ' (in a frame)' : ''}`;
    let t = 'element';
    if ((m = /getByRole\('([^']+)'(?:, \{ name: '((?:[^'\\]|\\.)*)'[^}]*\})?\)/.exec(last))) { const r = m[1] === 'textbox' || m[1] === 'spinbutton' || m[1] === 'searchbox' ? 'field' : m[1]; t = m[2] !== undefined ? `${r} "${unq(m[2])}"` : r; }
    else if ((m = /getByLabel\('((?:[^'\\]|\\.)*)'/.exec(last))) t = `field "${unq(m[1])}"`;
    else if ((m = /getByPlaceholder\('((?:[^'\\]|\\.)*)'/.exec(last))) t = `field "${unq(m[1])}"`;
    else if ((m = /getByTestId\('((?:[^'\\]|\\.)*)'/.exec(last))) t = `[${unq(m[1])}]`;
    else if ((m = /getByText\('((?:[^'\\]|\\.)*)'/.exec(last))) t = `text "${unq(m[1])}"`;
    else if ((m = /getByAltText\('((?:[^'\\]|\\.)*)'/.exec(last))) t = `image "${unq(m[1])}"`;
    else if ((m = /getByTitle\('((?:[^'\\]|\\.)*)'/.exec(last))) t = `"${unq(m[1])}"`;
    else if ((m = /locator\('((?:[^'\\]|\\.)*)'\)/.exec(last))) t = unq(m[1]);
    return inFrame ? `${t} (in a frame)` : t;
}

export function stepWords(line: string): { text: string; kind: 'action' | 'check' | 'note' | 'page' } {
    const l = line.trim();
    // The application moved to another page: a new page object from here on.
    const pg = /^\/\/ cs-page (\S+)/.exec(l);
    if (pg) { let p = pg[1]; try { p = new URL(pg[1]).pathname; } catch { /* as is */ } return { text: p, kind: 'page' }; }
    if (l.startsWith('//')) return { text: l.replace(/^\/\/\s*/, ''), kind: 'note' };
    // const orderNumber = await <element>.textContent(); // = "SO-1005": a value kept for later steps.
    const rm = /^const (\w+) = \(?await (.*)\.(textContent|innerText|inputValue)\(\)(?:\)\?\.match\(\/(.*)\/[a-z]*\)\?\.\[0\])?;(?:\s*\/\/ = (".*"))?$/.exec(l);
    if (rm) { let v = ''; try { v = rm[5] ? String(JSON.parse(rm[5])) : ''; } catch { /* none */ } return { text: `Remember ${rm[4] ? `the part like ${rm[4].replace(/\\\//g, '/')} of` : rm[3] === 'inputValue' ? 'the value of' : 'the text of'} ${targetWords(rm[2])} as ${rm[1]}${v ? ` ("${v}")` : ''}`, kind: 'check' }; }
    const dc = /^await cs\.dataCheck\('((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'\);$/.exec(l);
    if (dc) return { text: `Check: the test data ${unq(dc[1])}.${unq(dc[2])} is "${unq(dc[3])}"`, kind: 'check' };
    // await cs.dialog('accept', 'Delete?') / cs.switchTab('new' | 1)
    const dg = /^await cs\.dialog\('(accept|dismiss)', '((?:[^'\\]|\\.)*)'(?:, '((?:[^'\\]|\\.)*)')?\);$/.exec(l);
    if (dg) return { text: `Answer the dialog "${unq(dg[2]).slice(0, 60)}" with ${dg[1] === 'dismiss' ? 'Cancel' : dg[3] !== undefined ? `"${unq(dg[3])}"` : 'OK'}`, kind: 'action' };
    if (l === 'await cs.closeTab();') return { text: 'Close the tab', kind: 'action' };
    const pk = /^await page\.keyboard\.press\('((?:[^'\\]|\\.)*)'\);$/.exec(l);
    if (pk) return { text: `Press ${unq(pk[1])}`, kind: 'action' };
    const rc = /^await (.*)\.click\(\{ button: 'right' \}\);$/.exec(l);
    if (rc) return { text: `Right-click ${targetWords(rc[1])}`, kind: 'action' };
    const dr = /^await (.*)\.dragTo\((.*?)(?:, \{ targetPosition: \{ x: (\d+), y: (\d+) \} \})?\);(?: \/\/ of (\d+)x(\d+))?$/.exec(l);
    if (dr) return { text: dr[3] !== undefined && dr[5] ? `Drag ${targetWords(dr[1])} to ${Math.round((Number(dr[3]) / Number(dr[5])) * 100)}% across` : `Drag ${targetWords(dr[1])} onto ${targetWords(dr[2])}`, kind: 'action' };
    const tb = /^await cs\.switchTab\((?:'new'|(\d+))\);/.exec(l);
    if (tb) return { text: tb[1] === undefined ? 'Switch to the new tab' : `Switch to tab ${Number(tb[1]) + 1}`, kind: 'action' };
    // await cs.column(<cells>, 'equals', 'Open', { column: 'Status' }) / cs.waitFor(<el>, 'contains', 'Done', { reload: true, seconds: 120 })
    const cs = /^await cs\.(column|waitFor)\((.*), '(equals|contains|asc|desc|visible|hidden)'(?:, '((?:[^'\\]|\\.)*)')?(?:, \{(.*)\})?\);$/.exec(l);
    if (cs) {
        const col = /column: '((?:[^'\\]|\\.)*)'/.exec(cs[5] ?? '')?.[1];
        const what = col ? `column "${unq(col)}"` : targetWords(cs[2]);
        if (cs[1] === 'column') return { text: `Check: every row of ${what} ${cs[3] === 'equals' ? `is "${unq(cs[4] ?? '')}"` : cs[3] === 'contains' ? `contains "${unq(cs[4] ?? '')}"` : `is sorted ${cs[3] === 'asc' ? 'ascending' : 'descending'}`}`, kind: 'check' };
        const secs = /seconds: (\d+)/.exec(cs[5] ?? '')?.[1] ?? '60', reload = /reload: true/.test(cs[5] ?? '');
        return { text: `Wait until ${what} ${cs[3] === 'contains' ? `shows "${unq(cs[4] ?? '')}"` : cs[3] === 'visible' ? 'is shown' : 'is gone'} (up to ${secs} s${reload ? ', refreshing' : ''})`, kind: 'check' };
    }
    // expect(Number((await el.textContent())?.replace(…))).toBeGreaterThan(Number(cartCount) + 1)
    const cm = /^await expect\(Number\(\(await (.*)\.(?:textContent|innerText|inputValue)\(\)\)\?\.replace\(.*\)\)\)\.(not\.)?(toBe|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual)\((.*)\);$/.exec(l);
    if (cm) {
        const op = cm[2] ? 'different from' : ({ toBe: 'equal to', toBeGreaterThan: 'greater than', toBeGreaterThanOrEqual: 'at least', toBeLessThan: 'less than', toBeLessThanOrEqual: 'at most' } as Record<string, string>)[cm[3]];
        const rhs = cm[4].replace(/^Number\((\w+)\)/, 'the remembered $1');
        return { text: `Check: ${targetWords(cm[1])} is ${op} ${rhs}`, kind: 'check' };
    }
    let m: RegExpExecArray | null;
    if ((m = /^await page\.goto\('((?:[^'\\]|\\.)*)'\);$/.exec(l))) return { text: `Open ${unq(m[1])}`, kind: 'action' };
    if ((m = /^await expect\(page\)\.toHaveURL\(\/(.*)\/\);$/.exec(l))) return { text: `Check: the address contains ${m[1].replace(/\\(.)/g, '$1')}`, kind: 'check' };
    if ((m = /^await expect\(page\)\.toHaveTitle\('((?:[^'\\]|\\.)*)'\);$/.exec(l))) return { text: `Check: the page title is "${unq(m[1])}"`, kind: 'check' };
    if ((m = /^await expect\(page\)\.toHaveDownloaded\((.*)\);$/.exec(l))) return { text: `Check: a file like ${m[1].replace(/^'|'$/g, '').replace(/^\/\^?|\$?\/$/g, '').replace(/\\d\+/g, '#').replace(/\\(.)/g, '$1')} is downloaded`, kind: 'check' };
    if ((m = /^await expect\(page\.getByText\('((?:[^'\\]|\\.)*)'\)\)\.toBeHidden\(\);$/.exec(l))) return { text: `Check: "${unq(m[1])}" is not shown`, kind: 'check' };
    if ((m = /^await expect\((.*)\)\.(toBeEnabled|toBeDisabled|toBeHidden)\(\);$/.exec(l))) return { text: `Check: ${targetWords(m[1])} is ${{ toBeEnabled: 'enabled', toBeDisabled: 'disabled', toBeHidden: 'not shown' }[m[2]]}`, kind: 'check' };
    if ((m = /^await expect\((.*)\)\.toHaveAttribute\('((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'\);$/.exec(l))) return { text: `Check: ${targetWords(m[1])} has ${unq(m[2])}="${unq(m[3])}"`, kind: 'check' };
    if ((m = /^await expect\((.*)\)\.toHaveCount\((\d+)\);$/.exec(l))) return { text: `Check: ${m[2]} × ${targetWords(m[1])}`, kind: 'check' };
    if ((m = /^await expect\((.*)\)\.(toBeVisible|toHaveText|toContainText|toHaveValue|toBeChecked)\((?:'((?:[^'\\]|\\.)*)')?\);$/.exec(l))) {
        const t = targetWords(m[1]), v = m[3] !== undefined ? unq(m[3]) : '';
        const what = { toBeVisible: 'is shown', toHaveText: `shows "${v}"`, toContainText: `contains "${v}"`, toHaveValue: `has the value "${v}"`, toBeChecked: 'is checked' }[m[2]];
        return { text: `Check: ${t} ${what}`, kind: 'check' };
    }
    if ((m = /^await (.*)\.(click|dblclick|check|uncheck|hover)\(\);$/.exec(l))) {
        const verb = { click: 'Click', dblclick: 'Double-click', check: 'Tick', uncheck: 'Untick', hover: 'Point at' }[m[2]];
        return { text: `${verb} ${targetWords(m[1])}`, kind: 'action' };
    }
    if ((m = /^await (.*)\.fill\('((?:[^'\\]|\\.)*)'\);$/.exec(l))) {
        const t = targetWords(m[1]);
        const secret = /pass(word|code)?|\bpin\b|secret|\botp\b/i.test(t);
        return { text: `Type "${secret ? '••••••' : unq(m[2])}" in ${t}`, kind: 'action' };
    }
    if ((m = /^await (.*)\.press\('((?:[^'\\]|\\.)*)'\);$/.exec(l))) return { text: `Press ${unq(m[2])} in ${targetWords(m[1])}`, kind: 'action' };
    if ((m = /^await (.*)\.setInputFiles\((.*)\);$/.exec(l))) return { text: `Upload ${m[2].replace(/'((?:[^'\\]|\\.)*)'/g, (_x, v: string) => `"${unq(v)}"`).replace(/^\[|\]$/g, '')} to ${targetWords(m[1])}`, kind: 'action' };
    if ((m = /^await (.*)\.selectOption\((.*)\);$/.exec(l))) return { text: `Choose ${m[2].replace(/'((?:[^'\\]|\\.)*)'/g, (_x, v: string) => `"${unq(v)}"`).replace(/^\[|\]$/g, '')} in ${targetWords(m[1])}`, kind: 'action' };
    return { text: l, kind: 'action' };
}

/**
 * Parts of a text worth remembering on their own: codes with digits (SO-1005, INV/2026/0042) and numbers,
 * each with a pattern that finds the same kind of part in another run (digits may change).
 */
export function partsOf(text: string): Array<{ part: string; pattern: string }> {
    const out: Array<{ part: string; pattern: string }> = [];
    const words = text.split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter((w) => /\d/.test(w) && w !== text.trim());
    for (const w of words) {
        const pattern = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+');
        if (!out.some((x) => x.pattern === pattern)) out.push({ part: w, pattern });
    }
    if (/\d/.test(text) && !out.some((x) => x.pattern === '\\d+')) { const n = /\d+/.exec(text)![0]; if (n !== text.trim()) out.push({ part: n, pattern: '\\d+' }); }
    return out.slice(0, 4);
}

