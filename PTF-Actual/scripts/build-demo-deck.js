#!/usr/bin/env node
/**
 * Build a professional PowerPoint deck for the CS Playwright Test Framework
 * demo. Output: docs/CS-Framework-Demo-Slides.pptx
 *
 * 17 slides. Tester-perspective. Real architecture diagram.
 * Speaker notes embedded as native PowerPoint notes.
 *
 * Run: node scripts/build-demo-deck.js
 */
'use strict';

const path = require('path');
const PptxGenJS = require('pptxgenjs');

// ============================================================================
// Palette — restrained, professional
// ============================================================================
const C = {
    brand:     '4D004D',
    brandSft:  'F4ECF4',
    accent:    '7D2A7E',
    ink:       '1E293B',
    text:      '334155',
    muted:     '64748B',
    line:      'CBD5E1',
    border:    'E2E8F0',
    bg:        'FFFFFF',
    bgSoft:    'F8FAFC',
    green:     '047857',
    greenSft:  'D1FAE5',
    red:       'B91C1C',
    redSft:    'FEE2E2',
    amber:     'B45309',
    amberSft:  'FEF3C7',
    blue:      '1D4ED8',
    blueSft:   'DBEAFE',
};
const F = { sans: 'Calibri', mono: 'Consolas' };

// ============================================================================
const pres = new PptxGenJS();
pres.layout = 'LAYOUT_WIDE';
pres.author = 'CS Test Automation Team';
pres.company = 'Computershare';
pres.title = 'CS Playwright Test Framework';

pres.defineSlideMaster({
    title: 'BASE',
    background: { color: C.bg },
    objects: [
        { rect: { x: 0, y: 0, w: 13.33, h: 0.05, fill: { color: C.brand } } },
        { rect: { x: 0.5, y: 7.18, w: 12.33, h: 0.01, fill: { color: C.border } } },
        { text: {
            text: 'CS Playwright Test Framework',
            options: { x: 0.5, y: 7.25, w: 8, h: 0.2, fontSize: 8, color: C.muted, fontFace: F.sans }
        }},
    ],
    slideNumber: { x: 12.7, y: 7.25, w: 0.5, h: 0.2, fontSize: 8, color: C.muted, fontFace: F.sans, align: 'right' },
});

// ============================================================================
// Helpers
// ============================================================================
function title(s, t, sub) {
    s.addText(t, {
        x: 0.5, y: 0.3, w: 12.33, h: 0.55,
        fontSize: 24, bold: true, color: C.ink, fontFace: F.sans,
    });
    if (sub) {
        s.addText(sub, {
            x: 0.5, y: 0.82, w: 12.33, h: 0.32,
            fontSize: 12, color: C.muted, fontFace: F.sans,
        });
    }
    s.addShape(pres.ShapeType.rect, {
        x: 0.5, y: sub ? 1.18 : 0.92, w: 0.6, h: 0.04,
        fill: { color: C.brand }, line: { color: C.brand },
    });
}

function box(s, x, y, w, h, fill, border) {
    s.addShape(pres.ShapeType.rect, {
        x, y, w, h,
        fill: { color: fill || C.bg },
        line: { color: border || C.line, width: 1 },
    });
}

function arrow(s, x1, y1, x2, y2, color, width) {
    s.addShape(pres.ShapeType.line, {
        x: x1, y: y1, w: x2 - x1, h: y2 - y1,
        line: { color: color || C.muted, width: width || 1.25, endArrowType: 'triangle' },
    });
}

/**
 * Render a code block. Pass lines as either:
 *   - a plain string                  → default colour
 *   - { text: '...', color: 'XXXXXX' }→ explicit colour for that line
 */
function code(s, x, y, w, h, lines) {
    box(s, x, y, w, h, C.ink, C.ink);
    const runs = lines.map(l => {
        if (typeof l === 'string') {
            return { text: l + '\n', options: { fontSize: 11, fontFace: F.mono, color: C.bg } };
        }
        return {
            text: (l.text || '') + '\n',
            options: { fontSize: 11, fontFace: F.mono, color: l.color || C.bg, bold: !!l.bold, italic: !!l.italic },
        };
    });
    s.addText(runs, {
        x: x + 0.15, y: y + 0.1, w: w - 0.3, h: h - 0.2,
        fontFace: F.mono, valign: 'top',
    });
}

// Capability-card grid renderer used by feature slides
function capCard(s, x, y, w, h, opts) {
    box(s, x, y, w, h, C.bgSoft, C.line);
    s.addShape(pres.ShapeType.rect, {
        x, y, w: 0.08, h,
        fill: { color: opts.accent || C.brand }, line: { color: opts.accent || C.brand },
    });
    s.addText(opts.label, {
        x: x + 0.2, y: y + 0.1, w: w - 0.3, h: 0.3,
        fontSize: 11, bold: true, color: C.ink, fontFace: F.sans,
    });
    s.addText(opts.detail, {
        x: x + 0.2, y: y + 0.42, w: w - 0.3, h: h - 0.5,
        fontSize: 10, color: C.text, fontFace: F.sans, valign: 'top',
    });
}

// ============================================================================
// SLIDE 1 — Cover
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    s.addShape(pres.ShapeType.rect, {
        x: 0, y: 0, w: 0.4, h: 7.5,
        fill: { color: C.brand }, line: { color: C.brand },
    });
    s.addText('CS Playwright Test Framework', {
        x: 1.0, y: 2.6, w: 11.5, h: 0.8,
        fontSize: 40, bold: true, color: C.ink, fontFace: F.sans,
    });
    s.addText('Architecture, capabilities, and what testers get from it', {
        x: 1.0, y: 3.5, w: 11.5, h: 0.5,
        fontSize: 18, color: C.muted, fontFace: F.sans,
    });
    s.addShape(pres.ShapeType.line, {
        x: 1.0, y: 4.1, w: 2, h: 0,
        line: { color: C.brand, width: 3 },
    });
    s.addText('Computershare  ·  CS Test Automation Team  ·  v1.43.4', {
        x: 1.0, y: 6.7, w: 11.5, h: 0.3,
        fontSize: 11, color: C.muted, fontFace: F.sans,
    });
}

// ============================================================================
// SLIDE 2 — IS / IS NOT
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'What this framework is', 'A layer between your test code and Playwright that handles the unglamorous parts');

    const lY = 1.6, colW = 5.9, gap = 0.4;

    box(s, 0.5, lY, colW, 5.0, C.bgSoft, C.green);
    s.addShape(pres.ShapeType.rect, {
        x: 0.5, y: lY, w: colW, h: 0.5,
        fill: { color: C.green }, line: { color: C.green },
    });
    s.addText('IT IS', {
        x: 0.5, y: lY, w: colW, h: 0.5,
        fontSize: 14, bold: true, color: C.bg, fontFace: F.sans, align: 'center', valign: 'middle',
    });
    [
        'A wrapper around Playwright — every action goes through one chokepoint',
        'A Cucumber/BDD runner with TypeScript decorators for step definitions',
        'A multi-source data provider — CSV, Excel, JSON, XML, DB, API, generated',
        'A self-contained HTML/Excel/PDF reporter with no external dependencies',
        'An Azure DevOps publisher that closes the loop with one scenario tag',
        'A pre-built step library for API, DB, SOAP, browser, auth, accessibility',
    ].forEach((t, i) => {
        s.addText('•  ' + t, {
            x: 0.75, y: lY + 0.75 + i * 0.65, w: colW - 0.4, h: 0.6,
            fontSize: 12, color: C.text, fontFace: F.sans, valign: 'top',
        });
    });

    const x2 = 0.5 + colW + gap;
    box(s, x2, lY, colW, 5.0, C.bgSoft, C.muted);
    s.addShape(pres.ShapeType.rect, {
        x: x2, y: lY, w: colW, h: 0.5,
        fill: { color: C.muted }, line: { color: C.muted },
    });
    s.addText('IT IS NOT', {
        x: x2, y: lY, w: colW, h: 0.5,
        fontSize: 14, bold: true, color: C.bg, fontFace: F.sans, align: 'center', valign: 'middle',
    });
    [
        'A replacement for Playwright — we wrap, we do not fork',
        'A new BDD syntax — feature files are vanilla Gherkin',
        'A test recorder — Playwright codegen does that; we wrap it',
        'An ORM — database access is thin adapters per dialect',
        'A schema validator — ajv works fine; we compose it where needed',
        'Vendor lock-in — moving off is grep-and-replace, not a rewrite',
    ].forEach((t, i) => {
        s.addText('•  ' + t, {
            x: x2 + 0.25, y: lY + 0.75 + i * 0.65, w: colW - 0.4, h: 0.6,
            fontSize: 12, color: C.text, fontFace: F.sans, valign: 'top',
        });
    });

    s.addNotes(`Open by framing what this framework is and what it is not. It is a layer wrapping Playwright — not a replacement. It gives you BDD, data-driven, reporting, and ADO integration. It does not invent a new syntax. The IS NOT column heads off the most common adoption objection: vendor lock-in. Feature files are Gherkin. Step definitions are TypeScript. Data files are industry standard.`);
}

// ============================================================================
// SLIDE 3 — Architecture diagram
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Architecture', 'Components and data flow from feature file to ADO');

    // Layer 1: Test author
    const L1y = 1.4, L1h = 0.95;
    box(s, 0.5, L1y, 12.33, L1h, C.brandSft, C.brand);
    s.addText('TEST AUTHOR', {
        x: 0.6, y: L1y + 0.05, w: 2.5, h: 0.3,
        fontSize: 9, bold: true, color: C.brand, fontFace: F.sans,
    });
    const aw = 3.5, ay = L1y + 0.35, ah = 0.5;
    [
        { x: 0.85, label: '.feature  files', detail: 'Gherkin scenarios' },
        { x: 4.85, label: 'step definitions', detail: 'TypeScript + decorators' },
        { x: 8.85, label: 'page objects', detail: 'extends CSBasePage' },
    ].forEach(a => {
        box(s, a.x, ay, aw, ah, C.bg, C.brand);
        s.addText(a.label, {
            x: a.x, y: ay + 0.02, w: aw, h: 0.25,
            fontSize: 11, bold: true, color: C.brand, fontFace: F.mono, align: 'center',
        });
        s.addText(a.detail, {
            x: a.x, y: ay + 0.27, w: aw, h: 0.22,
            fontSize: 9, color: C.muted, fontFace: F.sans, align: 'center', italic: true,
        });
    });

    arrow(s, 6.65, L1y + L1h + 0.02, 6.65, L1y + L1h + 0.25, C.ink, 1.5);

    // Layer 2: CS Framework
    const L2y = 2.6, L2h = 2.6;
    box(s, 0.5, L2y, 12.33, L2h, C.bgSoft, C.ink);
    s.addText('CS FRAMEWORK', {
        x: 0.6, y: L2y + 0.05, w: 3, h: 0.3,
        fontSize: 9, bold: true, color: C.ink, fontFace: F.sans,
    });

    const row1y = L2y + 0.4, rowH = 0.55;
    [
        { x: 0.85, w: 3.5, label: 'BDD Engine', detail: 'Parses .feature, dispatches steps' },
        { x: 4.65, w: 3.5, label: 'Step Loader', detail: 'Lazy loads matching step files' },
        { x: 8.45, w: 4.18, label: 'Scenario Context', detail: 'Per-test state, files, actions' },
    ].forEach(r => {
        box(s, r.x, row1y, r.w, rowH, C.bg, C.line);
        s.addText(r.label, {
            x: r.x + 0.1, y: row1y + 0.02, w: r.w - 0.2, h: 0.25,
            fontSize: 11, bold: true, color: C.ink, fontFace: F.sans, valign: 'middle',
        });
        s.addText(r.detail, {
            x: r.x + 0.1, y: row1y + 0.28, w: r.w - 0.2, h: 0.25,
            fontSize: 9, color: C.muted, fontFace: F.sans, italic: true, valign: 'middle',
        });
    });

    const cpY = row1y + rowH + 0.15;
    const cpH = 1.25;
    box(s, 0.85, cpY, 11.78, cpH, C.brand, C.brand);
    s.addText('CSWebElement  ·  the chokepoint', {
        x: 0.85, y: cpY + 0.05, w: 11.78, h: 0.3,
        fontSize: 12, bold: true, color: C.bg, fontFace: F.sans, align: 'center',
    });
    const subs = [
        { label: 'Smart Wait', detail: 'predict + poll' },
        { label: 'Self-Heal', detail: '4 strategies' },
        { label: 'Secret Mask', detail: '22 patterns' },
        { label: 'Action Tracker', detail: 'pushes to report' },
        { label: 'Screenshot', detail: 'safe capture' },
        { label: 'File Tracker', detail: 'uploads/downloads' },
    ];
    const subW = 1.85, subY = cpY + 0.42, subH = 0.7, subGap = 0.07;
    subs.forEach((sb, i) => {
        const sx = 0.95 + i * (subW + subGap);
        box(s, sx, subY, subW, subH, C.brandSft, C.bg);
        s.addText(sb.label, {
            x: sx, y: subY + 0.03, w: subW, h: 0.3,
            fontSize: 10, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
        });
        s.addText(sb.detail, {
            x: sx, y: subY + 0.35, w: subW, h: 0.3,
            fontSize: 8, color: C.muted, fontFace: F.sans, italic: true, align: 'center',
        });
    });

    arrow(s, 6.65, L2y + L2h + 0.02, 6.65, L2y + L2h + 0.25, C.ink, 1.5);

    const L3y = 5.4, L3h = 0.55;
    box(s, 0.5, L3y, 12.33, L3h, C.amberSft, C.amber);
    s.addText('PLAYWRIGHT', {
        x: 0.6, y: L3y + 0.05, w: 2.5, h: 0.2,
        fontSize: 9, bold: true, color: C.amber, fontFace: F.sans,
    });
    s.addText('Page  ·  Locator  ·  Frame  ·  Browser context  ·  CDP session', {
        x: 0.6, y: L3y + 0.25, w: 12.13, h: 0.3,
        fontSize: 11, color: C.amber, fontFace: F.mono, align: 'center', valign: 'middle',
    });

    arrow(s, 6.65, L3y + L3h + 0.02, 6.65, L3y + L3h + 0.18, C.ink, 1.5);

    const L4y = 6.15, L4h = 0.85;
    box(s, 0.5, L4y, 12.33, L4h, C.greenSft, C.green);
    s.addText('OUTPUTS', {
        x: 0.6, y: L4y + 0.05, w: 2, h: 0.22,
        fontSize: 9, bold: true, color: C.green, fontFace: F.sans,
    });
    const outs = [
        { x: 0.85, label: 'Artifacts', detail: 'screenshots, video, HAR, traces' },
        { x: 4.0, label: 'HTML Report', detail: 'dashboard, tests, timeline, health' },
        { x: 7.15, label: 'Excel + PDF', detail: 'multi-sheet workbook + PDF' },
        { x: 10.3, label: 'ADO Push', detail: 'test plan, results, bugs' },
    ];
    const outW = 3.0, outY = L4y + 0.28, outH = 0.5;
    outs.forEach(o => {
        box(s, o.x, outY, outW, outH, C.bg, C.green);
        s.addText(o.label, {
            x: o.x + 0.05, y: outY + 0.02, w: outW - 0.1, h: 0.22,
            fontSize: 10, bold: true, color: C.green, fontFace: F.sans, valign: 'middle',
        });
        s.addText(o.detail, {
            x: o.x + 0.05, y: outY + 0.25, w: outW - 0.1, h: 0.22,
            fontSize: 8, color: C.muted, fontFace: F.sans, italic: true, valign: 'middle',
        });
    });

    s.addNotes(`Walk this diagram top to bottom. The test author writes three things — feature files, step definitions, and page objects. They feed into the framework. The framework has three top-level components — BDD engine, step loader, and scenario context. The HEART of the framework is the row underneath: CSWebElement. Every UI action goes through this one class, which is what gives us six free services. If a test bypassed CSWebElement and called Playwright directly, all six services would be lost. CSWebElement then calls Playwright underneath. The bottom row is where everything lands — artifacts on disk, HTML report, Excel/PDF, and Azure DevOps push.`);
}

// ============================================================================
// SLIDE 4 — How a test runs
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'How a test runs', 'From the command line to the final report');

    const steps = [
        { n: 1, t: 'CLI parses args',       d: 'cs-playwright-test --project --tags --parallel' },
        { n: 2, t: 'Config loads',          d: '8-level hierarchy, ENCRYPTED: values auto-decrypt' },
        { n: 3, t: 'Features parsed',       d: 'Lazy Cucumber Gherkin reads .feature files' },
        { n: 4, t: 'Steps registered',      d: '@CSBDDStepDef classes discovered selectively' },
        { n: 5, t: 'Browser launches',      d: 'Browser pool created on first scenario' },
        { n: 6, t: 'Scenario runs',         d: '@CSBefore -> steps -> @CSAfter, per scenario' },
        { n: 7, t: 'Step executes',         d: 'smart wait -> action -> screenshot -> tracker' },
        { n: 8, t: 'Failures recover',      d: 'Retry policy + self-heal attempts repair' },
        { n: 9, t: 'Artifacts persist',     d: 'screenshots/, videos/, har/, traces/, downloads/, uploads/' },
        { n:10, t: 'ADO pushes',            d: '@TestCaseId scenarios publish to Azure DevOps' },
        { n:11, t: 'Report generates',      d: 'Single self-contained HTML file, optional Excel/PDF' },
        { n:12, t: 'Process exits',         d: 'Zip artifacts if configured; correct exit code for CI' },
    ];

    const startY = 1.6;
    const rowH = 0.42, rowGap = 0.04;
    steps.forEach((step, i) => {
        const y = startY + i * (rowH + rowGap);
        s.addShape(pres.ShapeType.ellipse, {
            x: 0.5, y: y + 0.05, w: 0.32, h: 0.32,
            fill: { color: C.brand }, line: { color: C.brand },
        });
        s.addText(String(step.n), {
            x: 0.5, y: y + 0.05, w: 0.32, h: 0.32,
            fontSize: 10, bold: true, color: C.bg, fontFace: F.sans, align: 'center', valign: 'middle',
        });
        s.addText(step.t, {
            x: 1.0, y, w: 3.0, h: rowH,
            fontSize: 12, bold: true, color: C.ink, fontFace: F.sans, valign: 'middle',
        });
        s.addText(step.d, {
            x: 4.2, y, w: 8.6, h: rowH,
            fontSize: 11, color: C.text, fontFace: F.mono, valign: 'middle',
        });
    });

    s.addNotes(`Twelve steps from invocation to exit. Walk through at high speed. Highlight: step 4 — step registration is selective, only loads what features need (30-60x faster than eager). Step 7 — every UI action funnels through CSWebElement. Step 9 — every artifact has a known directory under the run timestamp folder.`);
}

// ============================================================================
// SLIDE 5 — Chokepoint pays off
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'What the chokepoint gives you', 'One line of test code — six framework services');

    s.addText('What the tester writes', {
        x: 0.5, y: 1.5, w: 5.9, h: 0.3,
        fontSize: 11, bold: true, color: C.muted, fontFace: F.sans,
    });
    code(s, 0.5, 1.85, 5.9, 1.0, [
        { text: 'await loginPage.submitButton', color: 'CBD5E1' },
        { text: '    .clickWithTimeout(30000);', color: '93C5FD' },
    ]);

    s.addText('What happens underneath', {
        x: 6.8, y: 1.5, w: 6.0, h: 0.3,
        fontSize: 11, bold: true, color: C.muted, fontFace: F.sans,
    });

    const services = [
        { label: '1. Smart wait', detail: 'predict step budget from history, poll DOM' },
        { label: '2. Self-heal', detail: 'if locator fails, try ARIA -> fingerprint -> fuzzy -> visual' },
        { label: '3. Action tracker', detail: 'push pass/fail entry to scenario context' },
        { label: '4. Secret mask', detail: 'scrub any typed-text from logs and HAR' },
        { label: '5. Screenshot', detail: 'capture on failure with three-strategy fallback' },
        { label: '6. File tracker', detail: 'register any download against the active step' },
    ];

    services.forEach((srv, i) => {
        const y = 1.85 + i * 0.7;
        s.addShape(pres.ShapeType.rect, {
            x: 6.8, y, w: 0.06, h: 0.55,
            fill: { color: C.brand }, line: { color: C.brand },
        });
        s.addText(srv.label, {
            x: 6.95, y, w: 6.0, h: 0.28,
            fontSize: 11, bold: true, color: C.ink, fontFace: F.sans,
        });
        s.addText(srv.detail, {
            x: 6.95, y: y + 0.28, w: 6.0, h: 0.3,
            fontSize: 10, color: C.muted, fontFace: F.sans, italic: true,
        });
    });

    box(s, 0.5, 3.1, 5.9, 3.5, C.brandSft, C.brand);
    s.addText('The tester wrote ONE line', {
        x: 0.5, y: 3.2, w: 5.9, h: 0.35,
        fontSize: 12, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    s.addText('No try/catch. No retry. No screenshot code.\nNo "did the page load yet" wait. No\nmasking concerns. No download tracking.', {
        x: 0.7, y: 3.6, w: 5.5, h: 1.5,
        fontSize: 13, color: C.text, fontFace: F.sans, align: 'center', italic: true, lineSpacingMultiple: 1.4,
    });
    s.addShape(pres.ShapeType.line, {
        x: 2.5, y: 5.2, w: 2, h: 0,
        line: { color: C.brand, width: 1.5 },
    });
    s.addText('All six services are mandatory.\nAll six are free.', {
        x: 0.7, y: 5.4, w: 5.5, h: 1.0,
        fontSize: 13, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });

    s.addNotes(`The most important slide in the deck because it shows what a tester ACTUALLY gets. The author wrote one method call. They never wrote a try/catch, screenshot capture, smart wait, or secret masking. All six services happen inside CSWebElement automatically.`);
}

// ============================================================================
// SLIDE 6 — Self-healing example
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Self-healing in action', 'Yesterday\'s green test stays green when the dev team renames an ID');

    box(s, 0.5, 1.5, 12.33, 0.6, C.amberSft, C.amber);
    s.addText('SCENARIO  ·  Passing test last sprint. Dev renamed #submit-btn to #submit-action.', {
        x: 0.5, y: 1.5, w: 12.33, h: 0.6,
        fontSize: 12, bold: true, color: C.amber, fontFace: F.sans, align: 'center', valign: 'middle',
    });

    const strats = [
        { n: 1, name: 'Accessibility tree',  detail: 'Find by ARIA role + label',           result: 'No match',    color: C.muted },
        { n: 2, name: 'Element fingerprint', detail: 'Match cached text + attribute hash',  result: 'MATCH 0.94',  color: C.green },
        { n: 3, name: 'Fuzzy text',          detail: 'Jaro-Winkler on visible text',        result: 'Skipped',     color: C.line },
        { n: 4, name: 'Visual similarity',   detail: 'Compare cached screenshot region',    result: 'Skipped',     color: C.line },
    ];

    strats.forEach((st, i) => {
        const y = 2.4 + i * 0.85;
        const isHit = st.result.startsWith('MATCH');
        box(s, 0.5, y, 12.33, 0.7, isHit ? C.greenSft : C.bgSoft, isHit ? C.green : C.border);
        s.addShape(pres.ShapeType.ellipse, {
            x: 0.7, y: y + 0.15, w: 0.4, h: 0.4,
            fill: { color: st.color }, line: { color: st.color },
        });
        s.addText(String(st.n), {
            x: 0.7, y: y + 0.15, w: 0.4, h: 0.4,
            fontSize: 11, bold: true, color: C.bg, fontFace: F.sans, align: 'center', valign: 'middle',
        });
        s.addText(st.name, {
            x: 1.3, y, w: 3.5, h: 0.7,
            fontSize: 13, bold: true, color: C.ink, fontFace: F.sans, valign: 'middle',
        });
        s.addText(st.detail, {
            x: 4.8, y, w: 4.5, h: 0.7,
            fontSize: 11, color: C.muted, fontFace: F.sans, italic: true, valign: 'middle',
        });
        s.addText(st.result, {
            x: 9.5, y, w: 3.2, h: 0.7,
            fontSize: 13, bold: true, color: isHit ? C.green : C.muted, fontFace: F.mono, valign: 'middle', align: 'right',
        });
    });

    box(s, 0.5, 6.0, 12.33, 0.7, C.greenSft, C.green);
    s.addText('Test passes. Report shows: [healed: element-fingerprint, 0.94, 38ms]', {
        x: 0.5, y: 6.0, w: 12.33, h: 0.7,
        fontSize: 13, bold: true, color: C.green, fontFace: F.mono, align: 'center', valign: 'middle',
    });

    s.addNotes(`A passing test yesterday, broken locator today because dev renamed an ID. Without self-heal you get a failed CI run and an hour of triage. With self-heal the framework tries four strategies in priority order. First it asks the accessibility tree — didn't match because the accessible name changed too. Second it asks the element fingerprint — matched because visible text and surrounding attributes are stable. The other two never run. Healing is logged in the report — never silent.`);
}

// ============================================================================
// SLIDE 7 — Smart wait predictor
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Smart wait predictor', 'Welford\'s algorithm learns timeouts from your actual test history');

    box(s, 0.5, 1.5, 12.33, 1.2, C.bgSoft, C.line);
    s.addText('RECOMMENDED TIMEOUT', {
        x: 0.5, y: 1.6, w: 12.33, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans, align: 'center',
    });
    s.addText([
        { text: 'mean + 1.645 · stddev', options: { fontSize: 22, color: C.brand, fontFace: F.mono, bold: true } },
        { text: '   ×   ', options: { fontSize: 22, color: C.text, fontFace: F.mono } },
        { text: '1.2', options: { fontSize: 22, color: C.accent, fontFace: F.mono, bold: true } },
    ], {
        x: 0.5, y: 1.95, w: 12.33, h: 0.4,
        fontFace: F.mono, align: 'center', valign: 'middle',
    });
    s.addText('95% upper confidence bound  +  20% safety margin  ->  rounded up to 100 ms', {
        x: 0.5, y: 2.4, w: 12.33, h: 0.25,
        fontSize: 10, color: C.muted, fontFace: F.sans, align: 'center', italic: true,
    });

    s.addText('Real example  ·  When I log in as a valid user', {
        x: 0.5, y: 2.95, w: 12.33, h: 0.35,
        fontSize: 12, bold: true, color: C.ink, fontFace: F.sans, align: 'center',
    });

    const tdata = [
        [
            { text: 'OBSERVATIONS', options: { bold: true, color: C.bg, fill: { color: C.ink }, fontSize: 11 } },
            { text: 'MEAN', options: { bold: true, color: C.bg, fill: { color: C.ink }, fontSize: 11, align: 'right' } },
            { text: 'STDDEV', options: { bold: true, color: C.bg, fill: { color: C.ink }, fontSize: 11, align: 'right' } },
            { text: 'RECOMMENDED', options: { bold: true, color: C.bg, fill: { color: C.ink }, fontSize: 11, align: 'right' } },
            { text: 'EFFECTIVE', options: { bold: true, color: C.bg, fill: { color: C.ink }, fontSize: 11, align: 'center' } },
        ],
        [
            { text: 'Run 1-4', options: { fontSize: 11, color: C.text } },
            { text: '—', options: { fontSize: 11, color: C.muted, align: 'right' } },
            { text: '—', options: { fontSize: 11, color: C.muted, align: 'right' } },
            { text: '—', options: { fontSize: 11, color: C.muted, align: 'right' } },
            { text: 'fallback 30s', options: { fontSize: 11, color: C.muted, align: 'center', italic: true } },
        ],
        [
            { text: 'Run 5 (5 samples)', options: { fontSize: 11, color: C.text, fill: { color: C.bgSoft } } },
            { text: '4.20s', options: { fontSize: 11, color: C.text, fill: { color: C.bgSoft }, align: 'right' } },
            { text: '0.31s', options: { fontSize: 11, color: C.text, fill: { color: C.bgSoft }, align: 'right' } },
            { text: '5.7s', options: { fontSize: 11, color: C.text, fill: { color: C.bgSoft }, align: 'right' } },
            { text: '5.7s', options: { fontSize: 11, bold: true, color: C.green, fill: { color: C.bgSoft }, align: 'center' } },
        ],
        [
            { text: 'Run 30 (mature)', options: { fontSize: 11, color: C.text } },
            { text: '4.18s', options: { fontSize: 11, color: C.text, align: 'right' } },
            { text: '0.24s', options: { fontSize: 11, color: C.text, align: 'right' } },
            { text: '5.5s', options: { fontSize: 11, color: C.text, align: 'right' } },
            { text: '5.5s', options: { fontSize: 11, bold: true, color: C.green, align: 'center' } },
        ],
    ];

    s.addTable(tdata, {
        x: 0.5, y: 3.4, w: 12.33, colW: [2.8, 2.0, 2.0, 3.0, 2.53],
        border: { type: 'solid', color: C.border, pt: 0.5 },
        fontFace: F.sans,
    });

    box(s, 0.5, 5.6, 12.33, 1.1, C.brandSft, C.brand);
    s.addText('Result for the tester:', {
        x: 0.5, y: 5.7, w: 12.33, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    s.addText('No more arbitrary 30s/60s timeouts. CI wall-clock drops. Flake from "ran out of wait" disappears.', {
        x: 0.5, y: 6.0, w: 12.33, h: 0.7,
        fontSize: 13, color: C.ink, fontFace: F.sans, align: 'center', valign: 'middle', italic: true,
    });

    s.addNotes(`Statistical backing, not magic. After five observations the predictor recommends a budget. The formula gives 95% upper bound plus 20% safety. A login that takes 4.2 seconds gets a 5.7s budget, not 30 or 60. Data persists at .cs-ai/waits/wait-data.json. Welford's algorithm is O(1) memory.`);
}

// ============================================================================
// SLIDE 8 — Multi-source data
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Multi-source data', 'One API call. Six sources. Filter syntax works on all of them.');

    code(s, 0.5, 1.6, 12.33, 3.2, [
        { text: '// Same API. Switch the source. Test code does not change.', color: '6EE7B7' },
        '',
        { text: "await CSDataProvider.load({ source: 'rates.csv',           filter: 'pair=EUR/USD' });", color: 'CBD5E1' },
        { text: "await CSDataProvider.load({ source: 'rates.xlsx',  sheet:  'Q4', filter: 'region=APAC' });", color: 'CBD5E1' },
        { text: "await CSDataProvider.load({ source: 'rates.json',  path:   '$.rates[*]' });", color: 'CBD5E1' },
        { text: "await CSDataProvider.load({ source: 'rates.xml',   xpath:  '//rate[@source=\"REFINITIV\"]' });", color: 'CBD5E1' },
        { text: "await CSDataProvider.load({ source: 'db://current-rates',  limit: 50 });", color: 'CBD5E1' },
        { text: "await CSDataProvider.load({ source: 'generate:rate-pairs', count: 100 });", color: 'CBD5E1' },
        '',
        { text: '// Built-in generators: {{uuid}} {{email}} {{phone}}', color: '6EE7B7' },
        { text: '//                      {{date}} {{timestamp}} {{random}}', color: '6EE7B7' },
    ]);

    box(s, 0.5, 4.95, 6.0, 1.85, C.bgSoft, C.line);
    s.addText('FILTER SYNTAX', {
        x: 0.5, y: 5.05, w: 6.0, h: 0.25,
        fontSize: 10, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    [
        { code: 'pair=EUR/USD;volume>1000000', note: '(AND)' },
        { code: 'region:APAC,EMEA', note: '(in-list)' },
        { code: 'name~Refinitiv', note: '(contains)' },
    ].forEach((row, i) => {
        const y = 5.35 + i * 0.32;
        s.addText(row.code, {
            x: 0.6, y, w: 4.4, h: 0.3,
            fontSize: 11, color: C.text, fontFace: F.mono, valign: 'middle',
        });
        s.addText(row.note, {
            x: 5.0, y, w: 1.4, h: 0.3,
            fontSize: 9, color: C.muted, fontFace: F.sans, italic: true, valign: 'middle',
        });
    });
    s.addText('Operators: = != > < >= <= ~ :', {
        x: 0.6, y: 6.4, w: 5.8, h: 0.3,
        fontSize: 10, color: C.muted, fontFace: F.sans, italic: true,
    });

    box(s, 6.8, 4.95, 6.03, 1.85, C.brandSft, C.brand);
    s.addText('WHAT TESTERS STOP DOING', {
        x: 6.8, y: 5.05, w: 6.03, h: 0.25,
        fontSize: 10, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    [
        'Writing CSV parsing code',
        'Writing Excel sheet handling',
        'Inventing date generators each project',
        'Inlining test data in TypeScript',
    ].forEach((item, i) => {
        s.addText('•  ' + item, {
            x: 6.95, y: 5.35 + i * 0.35, w: 5.8, h: 0.3,
            fontSize: 11, color: C.text, fontFace: F.sans, valign: 'middle',
        });
    });

    s.addNotes(`The data-driven story. The same load() call switches between CSV, Excel, JSON, XML, database, and generated data. Filter syntax is identical across all sources. Generators handle synthetic data without anyone inventing their own factories. The tester's benefit: test code doesn't change when they switch data sources.`);
}

// ============================================================================
// SLIDE 9 — Parallel execution
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Parallel execution', 'Independent child processes, not worker threads — no shared state');

    // Code example
    code(s, 0.5, 1.55, 12.33, 1.1, [
        { text: '# Run with 4 parallel workers', color: '6EE7B7' },
        { text: 'cs-playwright-test --project=crru --tags=@regression --parallel=4', color: 'CBD5E1' },
    ]);

    // Orchestrator + 4 workers diagram
    box(s, 4.65, 3.0, 4, 0.65, C.brand, C.brand);
    s.addText('Orchestrator', {
        x: 4.65, y: 3.0, w: 4, h: 0.65,
        fontSize: 13, bold: true, color: C.bg, fontFace: F.sans, align: 'center', valign: 'middle',
    });

    const workers = [
        { label: 'Worker 1', state: 'rates.feature' },
        { label: 'Worker 2', state: 'fx-publish.feature' },
        { label: 'Worker 3', state: 'spread.feature' },
        { label: 'Worker 4', state: 'history.feature' },
    ];
    workers.forEach((w, i) => {
        const x = 0.7 + i * 3.05;
        const y = 4.4;
        arrow(s, 6.65, 3.7, x + 1.3, y - 0.05, C.muted, 1.5);
        box(s, x, y, 2.6, 1.85, C.bgSoft, C.brand);
        s.addText(w.label, {
            x, y: y + 0.1, w: 2.6, h: 0.35,
            fontSize: 12, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
        });
        s.addText('own V8 isolate\nown browser\nown results dir', {
            x: x + 0.1, y: y + 0.5, w: 2.4, h: 0.85,
            fontSize: 9, color: C.muted, fontFace: F.sans, italic: true, align: 'center',
        });
        box(s, x + 0.5, y + 1.35, 1.6, 0.35, C.bg, C.green);
        s.addText(w.state, {
            x: x + 0.5, y: y + 1.35, w: 1.6, h: 0.35,
            fontSize: 8, color: C.green, fontFace: F.mono, align: 'center', valign: 'middle',
        });
    });

    box(s, 0.5, 6.55, 12.33, 0.55, C.brandSft, C.brand);
    s.addText('Crash recovery built in. Artifacts namespaced by worker ID. Aggregated at end-of-run.', {
        x: 0.5, y: 6.55, w: 12.33, h: 0.55,
        fontSize: 11, color: C.brand, fontFace: F.sans, align: 'center', valign: 'middle', italic: true,
    });

    s.addNotes(`Why child processes not worker threads: heavy browser contexts need isolated heaps. Worker threads share heap which means GC contention. Each child gets its own V8 isolate, its own browser, its own results directory. Crash recovery is built in — if a worker dies the orchestrator restarts it on the next item. Artifacts get a worker prefix so parallel screenshots/videos don't collide.`);
}

// ============================================================================
// SLIDE 10 — Auth + session reuse
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Authentication and session reuse', '12 auth types built in. Login once, run 20 scenarios.');

    // Auth types grid
    box(s, 0.5, 1.55, 6.0, 3.2, C.bgSoft, C.line);
    s.addText('12  AUTHENTICATION TYPES', {
        x: 0.5, y: 1.65, w: 6.0, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    const auths = [
        'Basic', 'Bearer', 'API Key', 'Digest',
        'JWT', 'OAuth2 + PKCE', 'AWS Sig v2/v4', 'NTLM',
        'Hawk', 'mTLS Cert', 'PingFederate', 'Custom',
    ];
    auths.forEach((a, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = 0.7 + col * 1.9;
        const y = 2.05 + row * 0.6;
        box(s, x, y, 1.75, 0.5, C.bg, C.brand);
        s.addText(a, {
            x, y, w: 1.75, h: 0.5,
            fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center', valign: 'middle',
        });
    });

    // Session reuse pattern
    s.addText('Session reuse pattern', {
        x: 6.8, y: 1.55, w: 6.0, h: 0.35,
        fontSize: 12, bold: true, color: C.ink, fontFace: F.sans,
    });
    code(s, 6.8, 1.95, 6.03, 1.4, [
        { text: '# In .env', color: '6EE7B7' },
        { text: 'AUTH_STORAGE_STATE_REUSE=true', color: 'CBD5E1' },
        { text: 'AUTH_STORAGE_STATE_PATH=./auth/state.json', color: 'CBD5E1' },
    ]);
    s.addText([
        { text: 'Login runs once.\n', options: { fontSize: 12, color: C.text, bold: true } },
        { text: 'Cookies, localStorage, and sessionStorage are\n', options: { fontSize: 11, color: C.text } },
        { text: 'persisted and replayed for every subsequent scenario.\n', options: { fontSize: 11, color: C.text } },
    ], {
        x: 6.8, y: 3.5, w: 6.03, h: 1.3,
        fontFace: F.sans, lineSpacingMultiple: 1.3,
    });

    // Speedup box
    box(s, 0.5, 5.05, 12.33, 1.8, C.brandSft, C.brand);
    s.addText('SPEEDUP ON AUTH-HEAVY SUITES', {
        x: 0.5, y: 5.15, w: 12.33, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    s.addText([
        { text: '20 logins  ', options: { fontSize: 28, color: C.muted, fontFace: F.mono, bold: true } },
        { text: '->  ', options: { fontSize: 24, color: C.text, fontFace: F.mono } },
        { text: '1 login + 19 reuses', options: { fontSize: 28, color: C.brand, fontFace: F.mono, bold: true } },
    ], {
        x: 0.5, y: 5.55, w: 12.33, h: 0.65,
        align: 'center', valign: 'middle',
    });
    s.addText('Measured: 5-10x faster wall-clock on heavy-auth suites', {
        x: 0.5, y: 6.3, w: 12.33, h: 0.4,
        fontSize: 12, color: C.brand, fontFace: F.sans, align: 'center', italic: true,
    });

    s.addNotes(`12 auth types out of the box: Basic, Bearer, API key, Digest, JWT, OAuth2 with PKCE, AWS Signature v2/v4, NTLM, Hawk, mTLS certificate, PingFederate SSO, and a custom handler hook. Session reuse is the big win — set AUTH_STORAGE_STATE_REUSE=true and the framework persists cookies and storage after the first login then replays them for subsequent scenarios. Measured 5-10x speedup on auth-heavy suites.`);
}

// ============================================================================
// SLIDE 11 — Secrets at rest and in transit
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Secret handling', 'Encrypted at rest. Masked at runtime. Both automatic.');

    // Left: encryption
    box(s, 0.5, 1.55, 6.0, 5.0, C.bgSoft, C.brand);
    s.addText('AT REST  ·  ENCRYPTION', {
        x: 0.5, y: 1.65, w: 6.0, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    code(s, 0.7, 2.05, 5.6, 1.0, [
        { text: '# In .env', color: '6EE7B7' },
        { text: 'DB_PASSWORD=ENCRYPTED:eyJpdiI6...', color: 'CBD5E1' },
    ]);
    s.addText('Algorithm', {
        x: 0.7, y: 3.2, w: 2.8, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    s.addText('AES-256-GCM', {
        x: 0.7, y: 3.5, w: 5.6, h: 0.4,
        fontSize: 14, bold: true, color: C.ink, fontFace: F.mono,
    });
    s.addText('Key derivation', {
        x: 0.7, y: 3.95, w: 2.8, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    s.addText('PBKDF2-SHA256  ·  350,000 iterations', {
        x: 0.7, y: 4.25, w: 5.6, h: 0.4,
        fontSize: 12, bold: true, color: C.ink, fontFace: F.mono,
    });
    s.addText('Safe to commit', {
        x: 0.7, y: 4.75, w: 2.8, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    s.addText('Encrypted values can ship with your repo.\nDecrypted only at runtime by CSValueResolver.', {
        x: 0.7, y: 5.05, w: 5.6, h: 1.4,
        fontSize: 11, color: C.text, fontFace: F.sans, italic: true,
    });

    // Right: masking
    box(s, 6.8, 1.55, 6.03, 5.0, C.bgSoft, C.accent);
    s.addText('AT RUNTIME  ·  MASKING', {
        x: 6.8, y: 1.65, w: 6.03, h: 0.3,
        fontSize: 11, bold: true, color: C.accent, fontFace: F.sans, align: 'center',
    });
    s.addText('22', {
        x: 6.8, y: 2.05, w: 6.03, h: 1.2,
        fontSize: 60, bold: true, color: C.accent, fontFace: F.sans, align: 'center',
    });
    s.addText('secret-detection patterns scanning every log line', {
        x: 6.8, y: 3.25, w: 6.03, h: 0.4,
        fontSize: 11, color: C.muted, fontFace: F.sans, italic: true, align: 'center',
    });
    s.addText('Detected automatically', {
        x: 6.95, y: 3.75, w: 5.7, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    s.addText([
        { text: 'password   ·  token   ·  bearer   ·  jwt\n', options: { fontSize: 11, color: C.text, fontFace: F.mono } },
        { text: 'api_key    ·  client_secret  ·  pat\n', options: { fontSize: 11, color: C.text, fontFace: F.mono } },
        { text: 'ssh_key    ·  connection_string\n', options: { fontSize: 11, color: C.text, fontFace: F.mono } },
        { text: 'AWS keys   ·  long hex strings   ·  JWT...\n', options: { fontSize: 11, color: C.text, fontFace: F.mono } },
    ], {
        x: 6.95, y: 4.05, w: 5.7, h: 1.5,
        fontFace: F.mono, lineSpacingMultiple: 1.4,
    });
    s.addText('Masked in logs, reports, HAR files', {
        x: 6.8, y: 5.7, w: 6.03, h: 0.7,
        fontSize: 12, bold: true, color: C.accent, fontFace: F.sans, align: 'center', italic: true,
    });

    s.addNotes(`Two layers of secret protection. At rest: any value prefixed with ENCRYPTED: in your .env files is AES-256-GCM encrypted with PBKDF2-SHA256 350,000-iteration key derivation. Decrypted only at runtime by CSValueResolver. Safe to commit encrypted values to git. At runtime: 22 regex patterns scan every log line, every report field, every HAR file looking for passwords, tokens, API keys, bearer tokens, JWTs, SSH keys, AWS credentials. Hits are replaced with ***MASKED*** before they hit stdout or disk. A junior engineer logging the login response cannot leak a token.`);
}

// ============================================================================
// SLIDE 12 — Network control
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Network control', 'Mocking, throttling, and HAR recording — built in');

    // Mocking + throttling code
    code(s, 0.5, 1.55, 12.33, 2.8, [
        { text: '// Mock a Refinitiv endpoint for offline testing', color: '6EE7B7' },
        { text: "await page.mockResponse({", color: 'CBD5E1' },
        { text: "    url: '**/api/rates/EURUSD',", color: 'CBD5E1' },
        { text: "    status: 200,", color: 'CBD5E1' },
        { text: "    body: { bid: 1.0852, ask: 1.0854, ts: '2026-06-09T14:30:00Z' }", color: 'CBD5E1' },
        { text: "});", color: 'CBD5E1' },
        '',
        { text: '// Simulate a slow network', color: '6EE7B7' },
        { text: "await page.simulateNetwork('slow-3g');", color: 'CBD5E1' },
        '',
        { text: '// HAR capture is automatic when HAR_CAPTURE_MODE=on-failure', color: '6EE7B7' },
    ]);

    // Three feature columns
    const feats = [
        {
            x: 0.5, accent: C.brand,
            label: 'NETWORK PROFILES',
            detail: '8 built-in throttling profiles\noffline · slow-2g · fast-2g\nslow-3g · fast-3g · slow-4g\nfast-4g · wifi',
        },
        {
            x: 4.65, accent: C.accent,
            label: 'REQUEST INTERCEPTION',
            detail: 'Mock responses by URL pattern\nModify request headers/body\nAbort or delay requests\nRecord and replay',
        },
        {
            x: 8.8, accent: C.green,
            label: 'HAR RECORDING',
            detail: 'Modes: never, on-first-retry,\non-failure, always\nPer-worker namespaced files\nAttached to test results',
        },
    ];
    feats.forEach(f => {
        capCard(s, f.x, 4.55, 4.0, 2.4, {
            accent: f.accent, label: f.label, detail: f.detail,
        });
    });

    s.addNotes(`Three network capabilities testers use. Mocking lets you test offline or against unreliable third-party services like Refinitiv. Set up a mock for the endpoint, the test runs deterministically. Throttling profiles let you verify the app behaves under slow-3g. HAR recording captures every request and response automatically — by default only on failure so you don't bloat artifacts on green runs.`);
}

// ============================================================================
// SLIDE 13 — Visual regression + Accessibility
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Visual regression and accessibility', 'Two checks every release needs — wrapped to be one line');

    // Visual regression
    box(s, 0.5, 1.55, 6.0, 5.2, C.bgSoft, C.brand);
    s.addText('VISUAL REGRESSION', {
        x: 0.5, y: 1.65, w: 6.0, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    code(s, 0.7, 2.05, 5.6, 0.95, [
        { text: '// Compare against baseline', color: '6EE7B7' },
        { text: "await visual.compare('rate-publication-page');", color: 'CBD5E1' },
    ]);
    s.addText('Algorithms', {
        x: 0.7, y: 3.15, w: 5.6, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    [
        { name: 'SSIM',  detail: 'structural similarity — catches layout shifts' },
        { name: 'pHash', detail: 'perceptual hashing — catches semantic moves' },
        { name: 'AI',    detail: 'optional semantic assertions on regions' },
    ].forEach((a, i) => {
        const y = 3.5 + i * 0.65;
        s.addShape(pres.ShapeType.rect, {
            x: 0.7, y, w: 0.05, h: 0.55,
            fill: { color: C.brand }, line: { color: C.brand },
        });
        s.addText(a.name, {
            x: 0.85, y, w: 1.0, h: 0.55,
            fontSize: 12, bold: true, color: C.brand, fontFace: F.mono, valign: 'middle',
        });
        s.addText(a.detail, {
            x: 1.95, y, w: 4.4, h: 0.55,
            fontSize: 10, color: C.text, fontFace: F.sans, italic: true, valign: 'middle',
        });
    });
    s.addText('Mask dynamic regions  ·  Versioned baselines  ·  Diff images on failure', {
        x: 0.7, y: 5.6, w: 5.6, h: 1.1,
        fontSize: 11, color: C.muted, fontFace: F.sans, italic: true, valign: 'top',
    });

    // Accessibility
    box(s, 6.8, 1.55, 6.03, 5.2, C.bgSoft, C.accent);
    s.addText('ACCESSIBILITY CHECKS', {
        x: 6.8, y: 1.65, w: 6.03, h: 0.3,
        fontSize: 11, bold: true, color: C.accent, fontFace: F.sans, align: 'center',
    });
    code(s, 7.0, 2.05, 5.6, 0.95, [
        { text: '// Snapshot the accessibility tree', color: '6EE7B7' },
        { text: "await page.checkAriaSnapshot('rate-page');", color: 'CBD5E1' },
    ]);
    s.addText('What it captures', {
        x: 7.0, y: 3.15, w: 5.6, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    s.addText('YAML representation of the entire ARIA tree:\nroles, labels, descriptions, focus order,\nlandmarks, headings hierarchy', {
        x: 7.0, y: 3.5, w: 5.6, h: 1.5,
        fontSize: 11, color: C.text, fontFace: F.sans, italic: true,
    });
    s.addText('Baseline comparison detects:', {
        x: 7.0, y: 5.05, w: 5.6, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    [
        'Missing alt text or labels',
        'Broken landmark structure',
        'Focus-order regressions',
        'Heading-hierarchy violations',
    ].forEach((item, i) => {
        s.addText('•  ' + item, {
            x: 7.2, y: 5.35 + i * 0.35, w: 5.4, h: 0.3,
            fontSize: 10, color: C.text, fontFace: F.sans, valign: 'middle',
        });
    });

    s.addNotes(`Two release-readiness checks. Visual regression compares the current page render to a baseline using SSIM, perceptual hashing, and optional AI semantic assertions. Mask dynamic regions like timestamps so they don't trigger false diffs. Accessibility checks use Playwright 1.59+ ariaSnapshot to capture the entire accessibility tree as YAML and compare to baseline. Catches missing alt text, broken landmarks, focus regressions before they reach users.`);
}

// ============================================================================
// SLIDE 14 — Smart retry + Test impact analysis
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Smart retry and test impact analysis', 'Two intelligence features that save CI minutes');

    // Smart retry (UCB1)
    box(s, 0.5, 1.55, 6.0, 5.2, C.bgSoft, C.brand);
    s.addText('SMART RETRY  ·  multi-armed bandit', {
        x: 0.5, y: 1.65, w: 6.0, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    s.addText('When a step fails, UCB1 picks the recovery\ntactic with the best historical track record\nfor that failure signature.', {
        x: 0.7, y: 2.05, w: 5.6, h: 1.0,
        fontSize: 11, color: C.text, fontFace: F.sans, italic: true,
    });

    const tactics = [
        { name: 'immediate',     detail: 'retry without delay' },
        { name: 'reload',        detail: 'refresh page, then retry' },
        { name: 'fresh-context', detail: 'close + reopen browser context' },
        { name: 'backoff',       detail: 'exponential delay then retry' },
    ];
    tactics.forEach((t, i) => {
        const y = 3.2 + i * 0.6;
        box(s, 0.7, y, 5.6, 0.5, C.bg, C.brand);
        s.addText(t.name, {
            x: 0.8, y, w: 1.8, h: 0.5,
            fontSize: 11, bold: true, color: C.brand, fontFace: F.mono, valign: 'middle',
        });
        s.addText(t.detail, {
            x: 2.7, y, w: 3.6, h: 0.5,
            fontSize: 10, color: C.text, fontFace: F.sans, italic: true, valign: 'middle',
        });
    });
    s.addText('History persists in .cs-smart-retry-data/', {
        x: 0.7, y: 6.0, w: 5.6, h: 0.3,
        fontSize: 9, color: C.muted, fontFace: F.mono, italic: true,
    });

    // Test impact analysis
    box(s, 6.8, 1.55, 6.03, 5.2, C.bgSoft, C.accent);
    s.addText('TEST IMPACT ANALYSIS', {
        x: 6.8, y: 1.65, w: 6.03, h: 0.3,
        fontSize: 11, bold: true, color: C.accent, fontFace: F.sans, align: 'center',
    });

    code(s, 7.0, 2.05, 5.6, 0.95, [
        { text: '# Run only tests affected by recent changes', color: '6EE7B7' },
        { text: 'cs-playwright-test --impact-analysis', color: 'CBD5E1' },
    ]);

    s.addText('How it works', {
        x: 7.0, y: 3.15, w: 5.6, h: 0.3,
        fontSize: 10, bold: true, color: C.muted, fontFace: F.sans,
    });
    [
        'Code coverage instrumentation tracks which tests touch which files',
        'When you commit a change, git diff identifies modified files',
        'The framework runs only the tests whose coverage intersects',
    ].forEach((item, i) => {
        s.addText(`${i + 1}.  ${item}`, {
            x: 7.0, y: 3.5 + i * 0.7, w: 5.6, h: 0.65,
            fontSize: 11, color: C.text, fontFace: F.sans, valign: 'top',
        });
    });

    box(s, 7.0, 5.7, 5.6, 0.6, C.brandSft, C.accent);
    s.addText('On a 2000-test suite, typical impact run = 50-200 tests', {
        x: 7.0, y: 5.7, w: 5.6, h: 0.6,
        fontSize: 11, bold: true, color: C.accent, fontFace: F.sans, align: 'center', valign: 'middle', italic: true,
    });

    s.addNotes(`Smart retry uses UCB1, an upper-confidence-bound bandit. When a step fails it picks among four tactics based on what has worked best historically for similar failure signatures. The four tactics are: immediate retry, reload + retry, fresh context, and exponential backoff. History persists so the bandit learns over weeks. Test impact analysis runs only the tests affected by your most recent changes. On a 2000-test suite a typical impact run is 50-200 tests, which means PR feedback in minutes not hours.`);
}

// ============================================================================
// SLIDE 15 — HTML report tour
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'The HTML report', 'One self-contained file. No CDN. No server. No telemetry.');

    box(s, 0.5, 1.5, 12.33, 1.5, C.bgSoft, C.border);
    s.addShape(pres.ShapeType.roundRect, {
        x: 0.7, y: 1.6, w: 4.5, h: 0.4,
        fill: { color: C.redSft }, line: { color: C.red, width: 1 }, rectRadius: 0.04,
    });
    s.addText('x  7 scenarios failed of 11', {
        x: 0.7, y: 1.6, w: 4.5, h: 0.4,
        fontSize: 11, bold: true, color: C.red, fontFace: F.sans, align: 'center', valign: 'middle',
    });

    const kpis = [
        { label: 'TOTAL',    value: '11',      tone: 'neutral', trend: '· same' },
        { label: 'PASSED',   value: '4',       tone: 'green',   trend: '-1' },
        { label: 'FAILED',   value: '7',       tone: 'red',     trend: '+2' },
        { label: 'SKIPPED',  value: '0',       tone: 'neutral', trend: '· same' },
        { label: 'RATE',     value: '36%',     tone: 'red',     trend: '-18%' },
        { label: 'DURATION', value: '6m 00s',  tone: 'neutral', trend: '+12s' },
    ];
    const cardW = 1.95, cardY = 2.15, cardH = 0.78;
    kpis.forEach((k, i) => {
        const x = 0.7 + i * (cardW + 0.05);
        const isGreen = k.tone === 'green', isRed = k.tone === 'red';
        const accent = isGreen ? C.green : isRed ? C.red : C.muted;
        const bg = isGreen ? C.greenSft : isRed ? C.redSft : C.bg;
        box(s, x, cardY, cardW, cardH, bg, accent);
        s.addShape(pres.ShapeType.rect, {
            x, y: cardY, w: 0.06, h: cardH,
            fill: { color: accent }, line: { color: accent },
        });
        s.addText(k.label, {
            x: x + 0.1, y: cardY + 0.02, w: cardW - 0.15, h: 0.22,
            fontSize: 8, bold: true, color: C.muted, fontFace: F.sans,
        });
        s.addText(k.value, {
            x: x + 0.1, y: cardY + 0.22, w: cardW - 0.15, h: 0.35,
            fontSize: 18, bold: true, color: isRed ? C.red : isGreen ? C.green : C.ink, fontFace: F.sans,
        });
        s.addText(k.trend, {
            x: x + 0.1, y: cardY + 0.55, w: cardW - 0.15, h: 0.2,
            fontSize: 8, color: C.muted, fontFace: F.mono, italic: true,
        });
    });

    box(s, 0.5, 3.15, 12.33, 1.4, C.bgSoft, C.border);
    const chips = [
        { label: 'All 11',    active: false },
        { label: 'Passed 4',  active: false },
        { label: 'Failed 7',  active: true },
        { label: 'Skipped 0', active: false },
    ];
    chips.forEach((ch, i) => {
        const x = 0.7 + i * 1.85;
        const y = 3.3;
        box(s, x, y, 1.65, 0.4, ch.active ? C.ink : C.bg, ch.active ? C.ink : C.border);
        s.addText(ch.label, {
            x, y, w: 1.65, h: 0.4,
            fontSize: 10, bold: true, color: ch.active ? C.bg : C.text, fontFace: F.sans, align: 'center', valign: 'middle',
        });
    });
    box(s, 8.1, 3.3, 4.5, 0.4, C.bg, C.border);
    s.addText('Search scenarios...', {
        x: 8.2, y: 3.3, w: 4.4, h: 0.4,
        fontSize: 10, color: C.muted, fontFace: F.sans, italic: true, valign: 'middle',
    });
    box(s, 0.7, 3.85, 11.93, 0.55, C.redSft, C.red);
    s.addShape(pres.ShapeType.rect, {
        x: 0.7, y: 3.85, w: 0.06, h: 0.55,
        fill: { color: C.red }, line: { color: C.red },
    });
    s.addText('x   When I submit a refund of $10,500', {
        x: 0.85, y: 3.85, w: 7.5, h: 0.55,
        fontSize: 11, color: C.ink, fontFace: F.sans, valign: 'middle',
    });
    s.addText('  Actions   ·   Screenshots   ·   Files (2)   ·   Failure', {
        x: 8.0, y: 3.85, w: 4.5, h: 0.55,
        fontSize: 10, color: C.muted, fontFace: F.sans, valign: 'middle',
    });

    box(s, 0.5, 4.7, 12.33, 1.85, C.bgSoft, C.border);
    s.addText('TEST HEALTH', {
        x: 0.5, y: 4.78, w: 12.33, h: 0.25,
        fontSize: 9, bold: true, color: C.muted, fontFace: F.sans, align: 'center',
    });
    const healthData = [
        [
            { text: 'TEST', options: { bold: true, color: C.muted, fill: { color: C.bg }, fontSize: 9 } },
            { text: 'HEALTH', options: { bold: true, color: C.muted, fill: { color: C.bg }, fontSize: 9 } },
            { text: 'SCORE', options: { bold: true, color: C.muted, fill: { color: C.bg }, fontSize: 9, align: 'right' } },
            { text: 'PASS RATE', options: { bold: true, color: C.muted, fill: { color: C.bg }, fontSize: 9, align: 'right' } },
            { text: 'HISTORY', options: { bold: true, color: C.muted, fill: { color: C.bg }, fontSize: 9 } },
        ],
        [
            { text: 'I submit a refund', options: { fontSize: 10, color: C.text } },
            { text: 'Flaky', options: { fontSize: 10, color: C.amber, bold: true } },
            { text: '32', options: { fontSize: 10, color: C.amber, bold: true, align: 'right' } },
            { text: '68%', options: { fontSize: 10, color: C.text, align: 'right' } },
            { text: '+ + + + x + + x + +', options: { fontSize: 10, color: C.text, fontFace: F.mono } },
        ],
        [
            { text: 'I publish a rate', options: { fontSize: 10, color: C.text, fill: { color: C.bg } } },
            { text: 'Stable', options: { fontSize: 10, color: C.green, bold: true, fill: { color: C.bg } } },
            { text: '4', options: { fontSize: 10, color: C.green, bold: true, fill: { color: C.bg }, align: 'right' } },
            { text: '96%', options: { fontSize: 10, color: C.text, fill: { color: C.bg }, align: 'right' } },
            { text: '+ + + + + + + + + +', options: { fontSize: 10, color: C.text, fontFace: F.mono, fill: { color: C.bg } } },
        ],
    ];
    s.addTable(healthData, {
        x: 0.7, y: 5.05, w: 11.93, colW: [4.0, 1.8, 1.5, 1.8, 2.83],
        border: { type: 'solid', color: C.border, pt: 0.5 },
        fontFace: F.sans, rowH: 0.4,
    });

    box(s, 0.5, 6.65, 12.33, 0.5, C.brandSft, C.brand);
    s.addText('Dashboard with trend deltas  ·  Filter chips + search  ·  Per-step Files tab  ·  Test Health with Wilson CI', {
        x: 0.5, y: 6.65, w: 12.33, h: 0.5,
        fontSize: 11, color: C.brand, fontFace: F.sans, align: 'center', valign: 'middle', italic: true,
    });

    s.addNotes(`Walk the report top to bottom. State line tells you what happened in one sentence. Six KPI cards with trend deltas tell you whether this run is better or worse than the last. Tests tab has chip filters and search that compose. Per-step tabs include the Files tab. Test Health table shows score, Wilson confidence interval, and run history. All in one HTML file — no CDN, no server.`);
}

// ============================================================================
// SLIDE 16 — Files tab + Failure clustering
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Two report features testers actually use', 'The Files tab and failure clustering remove specific friction');

    box(s, 0.5, 1.55, 6.0, 5.0, C.bgSoft, C.border);
    s.addText('PER-STEP FILES TAB', {
        x: 0.5, y: 1.65, w: 6.0, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    s.addText('Step that uploaded or downloaded a file', {
        x: 0.5, y: 1.95, w: 6.0, h: 0.25,
        fontSize: 10, color: C.muted, fontFace: F.sans, italic: true, align: 'center',
    });

    box(s, 0.7, 2.35, 5.6, 0.4, C.bg, C.line);
    s.addText('Actions   ·   Screenshots   ·   Files (2)   ·   Failure', {
        x: 0.7, y: 2.35, w: 5.6, h: 0.4,
        fontSize: 9, color: C.text, fontFace: F.sans, align: 'center', valign: 'middle',
    });
    const files = [
        { kind: 'UPLOAD',   name: 'rate-feed-EURUSD.csv', size: '2 KB',  color: C.brand },
        { kind: 'DOWNLOAD', name: 'rate-publication.xlsx', size: '50 KB', color: C.green },
    ];
    files.forEach((f, i) => {
        const y = 2.9 + i * 0.55;
        box(s, 0.7, y, 5.6, 0.45, C.bg, C.border);
        s.addShape(pres.ShapeType.rect, {
            x: 0.7, y, w: 0.06, h: 0.45,
            fill: { color: f.color }, line: { color: f.color },
        });
        s.addText(f.kind, {
            x: 0.85, y, w: 1.1, h: 0.45,
            fontSize: 9, bold: true, color: f.color, fontFace: F.sans, valign: 'middle',
        });
        s.addText(f.name, {
            x: 2.0, y, w: 3.2, h: 0.45,
            fontSize: 10, color: C.blue, fontFace: F.mono, valign: 'middle',
        });
        s.addText(f.size, {
            x: 5.2, y, w: 1.0, h: 0.45,
            fontSize: 9, color: C.muted, fontFace: F.mono, italic: true, valign: 'middle',
        });
    });
    s.addText('What it gives the tester:', {
        x: 0.7, y: 4.2, w: 5.6, h: 0.3,
        fontSize: 10, bold: true, color: C.ink, fontFace: F.sans,
    });
    [
        'Regression in a downloaded file? Click and see it.',
        'No more "the test passed but did it really?"',
        'Auto-saved against the step that touched it.',
        'Works with framework uploads and downloads.',
    ].forEach((t, i) => {
        s.addText('•  ' + t, {
            x: 0.85, y: 4.55 + i * 0.45, w: 5.45, h: 0.45,
            fontSize: 10, color: C.text, fontFace: F.sans, valign: 'middle',
        });
    });

    box(s, 6.8, 1.55, 6.03, 5.0, C.bgSoft, C.border);
    s.addText('FAILURE CLUSTERING (DBSCAN)', {
        x: 6.8, y: 1.65, w: 6.03, h: 0.3,
        fontSize: 11, bold: true, color: C.brand, fontFace: F.sans, align: 'center',
    });
    s.addText('When 12 failures share a root cause', {
        x: 6.8, y: 1.95, w: 6.03, h: 0.25,
        fontSize: 10, color: C.muted, fontFace: F.sans, italic: true, align: 'center',
    });

    s.addText('12', {
        x: 6.8, y: 2.4, w: 2.7, h: 1.4,
        fontSize: 80, bold: true, color: C.red, fontFace: F.sans, align: 'center',
    });
    s.addText('failures', {
        x: 6.8, y: 3.7, w: 2.7, h: 0.3,
        fontSize: 11, color: C.muted, fontFace: F.sans, italic: true, align: 'center',
    });

    arrow(s, 9.6, 3.1, 10.1, 3.1, C.muted, 2);

    s.addText('1', {
        x: 10.1, y: 2.4, w: 2.7, h: 1.4,
        fontSize: 80, bold: true, color: C.green, fontFace: F.sans, align: 'center',
    });
    s.addText('cluster', {
        x: 10.1, y: 3.7, w: 2.7, h: 0.3,
        fontSize: 11, color: C.muted, fontFace: F.sans, italic: true, align: 'center',
    });

    s.addText('What it gives the tester:', {
        x: 6.95, y: 4.2, w: 5.7, h: 0.3,
        fontSize: 10, bold: true, color: C.ink, fontFace: F.sans,
    });
    [
        'Composite Jaccard on error + stack frames',
        'Sorted by cluster size — fix biggest first',
        'Outliers surfaced separately',
        'No more "1 bug or 12?" guesswork',
    ].forEach((t, i) => {
        s.addText('•  ' + t, {
            x: 7.1, y: 4.55 + i * 0.45, w: 5.55, h: 0.45,
            fontSize: 10, color: C.text, fontFace: F.sans, valign: 'middle',
        });
    });

    s.addNotes(`Two report features that get the strongest reaction from testers. Files tab: when a step downloads or uploads a file, the report shows it with a clickable link. A regression visible only in the downloaded file used to be invisible from the report — now click and see it. Failure clustering: DBSCAN with Jaccard similarity groups failures by error message and stack frames. Twelve failures become one cluster. Fix the cluster, fix all twelve.`);
}

// ============================================================================
// SLIDE 17 — ADO loop
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    title(s, 'Closing the ADO loop', 'One tag in your scenario, one push to Azure DevOps');

    code(s, 0.5, 1.55, 12.33, 1.95, [
        { text: '@TestPlanId:417 @TestSuiteId:418', color: '93C5FD' },
        { text: 'Feature: Refinitiv rate publication', color: 'F5F5F4' },
        '',
        { text: '    @TestCaseId:{419,420,421}', color: '6EE7B7' },
        { text: '    Scenario Outline: Publish <currency_pair> spot rate', color: 'F5F5F4' },
        { text: '        Given a rate feed from REFINITIV for <currency_pair>', color: 'CBD5E1' },
        { text: '        When  I publish the rate at the current spot', color: 'CBD5E1' },
        { text: '        Then  the rate appears in the published-rates table', color: 'CBD5E1' },
    ]);

    arrow(s, 6.65, 3.7, 6.65, 4.2, C.ink, 2);

    const outs = [
        { label: 'Test Run created', detail: 'with all collected test points before run starts', color: C.brand },
        { label: 'Per-scenario result published', detail: 'pass/fail + duration + error + iteration data', color: C.green },
        { label: 'Attachments uploaded', detail: 'screenshots, videos, HAR files, traces, logs', color: C.blue },
        { label: 'Bugs auto-filed on failure', detail: 'configurable template — area path, priority, severity', color: C.red },
    ];
    outs.forEach((o, i) => {
        const y = 4.35 + i * 0.65;
        box(s, 0.5, y, 12.33, 0.55, C.bgSoft, o.color);
        s.addShape(pres.ShapeType.rect, {
            x: 0.5, y, w: 0.08, h: 0.55,
            fill: { color: o.color }, line: { color: o.color },
        });
        s.addText('✓', {
            x: 0.7, y, w: 0.4, h: 0.55,
            fontSize: 16, bold: true, color: o.color, fontFace: F.sans, align: 'center', valign: 'middle',
        });
        s.addText(o.label, {
            x: 1.2, y, w: 5.0, h: 0.55,
            fontSize: 12, bold: true, color: C.ink, fontFace: F.sans, valign: 'middle',
        });
        s.addText(o.detail, {
            x: 6.5, y, w: 6.0, h: 0.55,
            fontSize: 11, color: C.muted, fontFace: F.sans, italic: true, valign: 'middle',
        });
    });

    s.addNotes(`The answer to "we have ADO already, why move?" — you don't have to move; you wire one tag. Tag a scenario with @TestCaseId:419 and the framework creates the test run, publishes the result, attaches screenshots, and optionally files a bug. Two-phase architecture: parallel workers emit results to IPC; parent orchestrator publishes one batch. Manual ADO data entry after every regression — gone.`);
}

// ============================================================================
// SLIDE 18 — Q&A
// ============================================================================
{
    const s = pres.addSlide({ masterName: 'BASE' });
    s.addShape(pres.ShapeType.rect, {
        x: 0, y: 0, w: 13.33, h: 7.5,
        fill: { color: C.brand }, line: { color: C.brand },
    });

    s.addText('Questions?', {
        x: 0.5, y: 2.5, w: 12.33, h: 1.0,
        fontSize: 56, bold: true, color: C.bg, fontFace: F.sans, align: 'center',
    });
    s.addShape(pres.ShapeType.line, {
        x: 5.665, y: 3.7, w: 2, h: 0,
        line: { color: C.bg, width: 3 },
    });
    s.addText('Architecture · Patterns · Adoption · Reports · ADO', {
        x: 0.5, y: 4.0, w: 12.33, h: 0.5,
        fontSize: 16, color: C.bg, fontFace: F.sans, align: 'center', italic: true,
    });

    s.addText('CS Test Automation Team  ·  Computershare', {
        x: 0.5, y: 6.7, w: 12.33, h: 0.3,
        fontSize: 11, color: C.bg, fontFace: F.sans, align: 'center',
    });

    s.addNotes(`Reserve 10-15 minutes for Q&A. Top expected questions: (1) Why wrap Playwright? The chokepoint. (2) Self-heal masking bugs? Every heal logged with strategy + confidence. (3) Smart waits poisoned by slow tests? Welford is outlier-robust, needs 5 observations. (4) Why move from Allure? Single HTML file, clustering, per-step files. (5) Vendor lock-in? Gherkin, TypeScript, CSV — all standard.`);
}

// ============================================================================
const outputPath = path.join(__dirname, '..', 'docs', 'CS-Framework-Demo-Slides.pptx');
pres.writeFile({ fileName: outputPath }).then((p) => {
    console.log('Wrote: ' + p);
}).catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
});
