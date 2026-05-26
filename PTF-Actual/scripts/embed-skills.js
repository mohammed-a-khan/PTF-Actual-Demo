#!/usr/bin/env node

/**
 * Pre-build script: Embed skill folders into TypeScript.
 *
 * Reads src/mcp/skills/<skill-name>/** (markdown + bundled assets like
 * rules.yaml, example .ts files) and generates
 * src/mcp/skills/embeddedSkillContent.ts.
 *
 * Emits two exports:
 *
 *   SKILL_CONTENT — Record<skillName, Record<fileRelPath, rawText>>
 *                   Full skill content, identical to the pre-1.39 shape.
 *                   Used by consumer init-agents to write files to
 *                   .github/skills/, and by code paths that already
 *                   reference SKILL_CONTENT directly.
 *
 *   SKILL_INDEX   — Record<skillName, SkillIndexEntry>
 *                   Lightweight metadata used by CSSkillRetriever for
 *                   BM25-filtered retrieval. Includes phase / fileKind /
 *                   tags derived from naming conventions + any explicit
 *                   frontmatter overrides, plus a tokenized body for
 *                   scoring. Body text itself is NOT duplicated here —
 *                   the retriever pulls it from SKILL_CONTENT[name]['SKILL.md'].
 *
 * Run: node scripts/embed-skills.js
 * Triggered automatically by: npm run build (pre-build phase).
 */

const fs = require('fs');
const path = require('path');

const skillsDir = path.join(__dirname, '..', 'src', 'mcp', 'skills');
const outputFile = path.join(skillsDir, 'embeddedSkillContent.ts');

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function walk(dir, base = dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walk(full, base));
        } else if (entry.isFile()) {
            const rel = path.relative(base, full).replace(/\\/g, '/');
            results.push({ absPath: full, relPath: rel });
        }
    }
    return results;
}

function escapeForTemplateLiteral(content) {
    return content
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
}

/**
 * Parse very-light YAML frontmatter (the subset used by SKILL.md):
 *   key: scalar value
 *   key: [a, b, c]
 *   key: ["a", "b"]
 * Returns a record of declared keys plus the body text after the closing `---`.
 */
function parseFrontmatter(text) {
    if (!text.startsWith('---')) return { meta: {}, body: text };
    const closing = text.indexOf('\n---', 3);
    if (closing === -1) return { meta: {}, body: text };
    const block = text.slice(3, closing).trim();
    const body = text.slice(closing + 4).replace(/^\s*\n/, '');
    const meta = {};
    for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        let value = m[2].trim();
        const arrMatch = /^\[(.*)\]$/.exec(value);
        if (arrMatch) {
            meta[key] = arrMatch[1]
                .split(',')
                .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter((s) => s.length > 0);
        } else {
            meta[key] = value.replace(/^['"]|['"]$/g, '');
        }
    }
    return { meta, body };
}

/**
 * Derive (phase, fileKind, tags) from the skill name when frontmatter does
 * not declare them explicitly. Prefix-driven heuristics, kept in one place
 * so the conventions are auditable.
 */
function deriveTaxonomy(skillName) {
    const tags = new Set();
    let phase;
    let fileKind;

    if (skillName.startsWith('po-')) {
        phase = 'translate';
        fileKind = 'page';
        tags.add('page-object');
    } else if (skillName.startsWith('sd-')) {
        phase = 'translate';
        fileKind = 'steps';
        tags.add('step-definition');
    } else if (skillName.startsWith('ff-')) {
        phase = 'translate';
        fileKind = 'feature';
        tags.add('feature-file');
    } else if (skillName.startsWith('heal-')) {
        phase = 'heal';
        tags.add('healing');
    } else if (skillName.startsWith('audit-')) {
        phase = 'audit';
        tags.add('audit');
    } else if (skillName.startsWith('db-')) {
        phase = 'translate';
        fileKind = 'steps';
        tags.add('database');
    } else if (skillName.startsWith('legacy-example-')) {
        phase = 'analyze';
        fileKind = 'legacy-source';
        tags.add('legacy-example');
    } else if (skillName.startsWith('ado-')) {
        phase = 'publish';
        tags.add('ado');
    } else if (skillName.startsWith('xlsx-') || skillName === 'excel-data-driven' || skillName === 'csv-data-driven') {
        phase = 'translate';
        fileKind = 'data';
        tags.add('data-driven');
    }

    // Topic tags (additive — independent of phase/fileKind).
    if (/dialog/.test(skillName)) tags.add('dialog');
    if (/iframe|frame/.test(skillName)) tags.add('iframe');
    if (/self-healing/.test(skillName)) tags.add('self-healing');
    if (/dynamic/.test(skillName)) tags.add('dynamic');
    if (/timezone|americas/.test(skillName)) tags.add('datetime');
    if (/encrypted/.test(skillName)) tags.add('encryption');
    if (/api-call/.test(skillName)) tags.add('api');
    if (/scenario-outline/.test(skillName)) tags.add('scenario-outline');
    if (/smoke/.test(skillName)) tags.add('smoke');
    if (/reporter/.test(skillName)) tags.add('reporter');
    if (/clarification/.test(skillName)) tags.add('clarification');
    if (/handoff-contracts/.test(skillName)) tags.add('handoff');
    if (/correction-memory/.test(skillName)) tags.add('memory');
    if (/mutation/.test(skillName)) tags.add('mutation');
    if (/commit-ready/.test(skillName)) tags.add('commit-gate');

    return { phase, fileKind, tags: Array.from(tags).sort() };
}

/**
 * Cheap content tokenizer used both at index build time and at retrieval
 * time. Lowercases, strips markdown punctuation, splits on non-word
 * characters, drops stopwords + tokens shorter than 3 chars.
 */
// Classic English stopwords only — `page`/`step`/`file`/`test` deliberately
// KEPT because the skill corpus is heavily about pages/steps/files/tests
// and filtering them tanked BM25 recall on every relevant query.
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'are', 'use', 'used', 'using',
    'when', 'then', 'from', 'into', 'have', 'has', 'will', 'each', 'must',
    'not', 'but', 'all', 'any', 'one', 'two', 'see', 'per', 'via', 'than',
    'also', 'only', 'just', 'such', 'more', 'most', 'less', 'over', 'under',
    'about', 'these', 'those', 'their', 'them', 'they', 'you', 'your',
    'how', 'why', 'what', 'where', 'which', 'who',
    'after', 'before', 'while', 'until', 'because',
]);

function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// ----------------------------------------------------------------------------
// build
// ----------------------------------------------------------------------------

let output = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 *
 * Generated by: scripts/embed-skills.js
 * Source files: src/mcp/skills/<skill-name>/**
 *
 * Re-run "node scripts/embed-skills.js" after editing any skill file.
 * This file is automatically regenerated during "npm run build".
 */

export interface SkillIndexEntry {
    /** Skill folder name (the id used by retrievers). */
    id: string;
    /** From frontmatter \`name:\`. Falls back to id. */
    title: string;
    /** One-line summary from frontmatter \`description:\`. May be empty. */
    summary: string;
    /** Pipeline phase the skill applies to (translate | analyze | audit | heal | publish | …). */
    phase?: string;
    /** Target file kind for translate-phase skills (page | steps | feature | data | legacy-source). */
    fileKind?: string;
    /** Topical tags. Both naming-derived and explicitly-declared in frontmatter are merged. */
    tags: readonly string[];
    /** Tokenised body content (markdown stripped, stopwords removed). Used for BM25 scoring. */
    bodyTokens: readonly string[];
    /** Pre-computed token count of body. */
    bodyLength: number;
}

export const SKILL_CONTENT: Record<string, Record<string, string>> = {
`;

let skillCount = 0;
let fileCount = 0;
const indexEntries = [];

if (!fs.existsSync(skillsDir)) {
    console.warn(`  Warning: skills dir not found: ${skillsDir}`);
    fs.writeFileSync(
        outputFile,
        output +
            '};\n\nexport const SKILL_INDEX: Record<string, SkillIndexEntry> = {};\n\nexport const SKILL_NAMES: readonly string[] = [];\n',
        'utf-8',
    );
    process.exit(0);
}

const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

for (const skillName of skills) {
    const skillRoot = path.join(skillsDir, skillName);
    const files = walk(skillRoot, skillRoot);
    if (files.length === 0) continue;

    output += `    '${skillName}': {\n`;

    let skillMdContent = '';
    for (const { absPath, relPath } of files) {
        const raw = fs.readFileSync(absPath, 'utf-8');
        const normalised = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (relPath === 'SKILL.md') skillMdContent = normalised;
        const escaped = escapeForTemplateLiteral(normalised);
        output += `        '${relPath}': \`${escaped}\`,\n`;
        fileCount++;
    }
    output += `    },\n`;
    skillCount++;

    // ----- build index entry -----
    const { meta, body } = parseFrontmatter(skillMdContent);
    const derived = deriveTaxonomy(skillName);
    const explicitTags = Array.isArray(meta.tags) ? meta.tags : [];
    const mergedTags = Array.from(new Set([...derived.tags, ...explicitTags])).sort();
    indexEntries.push({
        id: skillName,
        title: meta.name || skillName,
        summary: meta.description || '',
        phase: meta.phase || derived.phase,
        fileKind: meta.fileKind || meta.file_kind || derived.fileKind,
        tags: mergedTags,
        bodyTokens: tokenize(`${meta.name || skillName} ${meta.description || ''} ${body}`),
    });
}

output += `};\n\n`;

// Emit SKILL_INDEX. Each entry's bodyTokens is kept compact (single array on one line).
output += `export const SKILL_INDEX: Record<string, SkillIndexEntry> = {\n`;
for (const e of indexEntries) {
    const safeTokens = JSON.stringify(e.bodyTokens);
    const safeTags = JSON.stringify(e.tags);
    const safeTitle = JSON.stringify(e.title);
    const safeSummary = JSON.stringify(e.summary);
    output += `    '${e.id}': {\n`;
    output += `        id: '${e.id}',\n`;
    output += `        title: ${safeTitle},\n`;
    output += `        summary: ${safeSummary},\n`;
    if (e.phase) output += `        phase: '${e.phase}',\n`;
    if (e.fileKind) output += `        fileKind: '${e.fileKind}',\n`;
    output += `        tags: ${safeTags},\n`;
    output += `        bodyTokens: ${safeTokens},\n`;
    output += `        bodyLength: ${e.bodyTokens.length},\n`;
    output += `    },\n`;
}
output += `};\n\n`;
output += `export const SKILL_NAMES: readonly string[] = ${JSON.stringify(skills)} as const;\n`;

fs.writeFileSync(outputFile, output, 'utf-8');
console.log(`✅ Embedded ${skillCount} skills (${fileCount} files) + index entries into ${path.relative(process.cwd(), outputFile)}`);
