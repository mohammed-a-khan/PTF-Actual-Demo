/**
 * Agentic Test Platform — Legacy Dependency Graph Tracer
 *
 * Solves the "scope mapper pulls in every page in the folder" problem.
 * Before this module existed, downstream phases got a flat
 * `inventory.pages[]` listing every page-shaped file in the legacy
 * project, and the LLM had to GUESS which ones were actually relevant
 * to the entry test. With ~50 pages in a real consumer project, that
 * routinely produced runs where the BDD-author "helpfully" appended
 * pages from completely unrelated modules.
 *
 * The fix: deterministic transitive-import closure from the entry file.
 *
 *   1. Build a project-wide `FQN → file` index (Java: package + class
 *      name; C#: namespace + class name).
 *   2. BFS from the entry file:
 *        - Parse the file's `import` / `using` declarations.
 *        - Filter to company-package imports (everything else is JDK /
 *          framework / third-party and intentionally NOT followed).
 *        - Resolve each import to a project file via the FQN index.
 *        - Enqueue resolved files, track `importedBy` + `depth`.
 *   3. For helper bodies that load DATA files via string literals
 *      (`new ExcelReader("admin-data.xlsx")`, `loadProperties(...)`,
 *      etc.), capture filename references and add data files as graph
 *      nodes too.
 *   4. For data files themselves (xlsx/csv/json/xml/properties), scan
 *      cell values for further data-file references. A column like
 *      `dataFile: payment-config.xml` is a transitive dependency.
 *      Capped at depth 8 to avoid infinite recursion on circular refs.
 *   5. Compute `unrelated`: every project file NOT in the closure. The
 *      downstream agent prompts surface this list as "DO NOT include
 *      these — they were not imported by the entry test."
 *
 * Output is written to `runFolder/02-discover/dependency-graph.json` so
 * analyze + scope-mapper + bdd-author can consume the closure directly
 * instead of the flat inventory.
 *
 * @module agent-platform/CSDependencyGraph
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSLegacyDataReader } from './CSLegacyDataReader';

// ============================================================================
// Public Types
// ============================================================================

export type DependencyKind =
    | 'entry'
    | 'base-class'
    | 'page'
    | 'helper'
    | 'login-page'
    | 'data'
    | 'config'
    | 'unknown';

export interface DependencyNode {
    /** Path relative to the project root, forward-slash. */
    relativePath: string;
    /** Absolute path on disk. */
    absolutePath: string;
    /** Best-effort classification (matches LegacyFile.kind values plus 'entry'). */
    kind: DependencyKind;
    /** Hop distance from the entry file (entry=0). */
    depth: number;
    /** Files that imported / referenced this node. relativePath list. */
    importedBy: string[];
    /** Company-package imports declared in this file (FQN list). */
    imports: readonly string[];
    /** Filename references discovered inside string literals or cell values. */
    references: readonly string[];
}

export interface UnrelatedFile {
    relativePath: string;
    /** Why we know it's unrelated — almost always "not in transitive closure of entry file". */
    reason: string;
}

export interface DependencyGraph {
    entryFile: string;
    projectRoot: string;
    /** Company package prefix(es) detected from the entry file + neighbours. */
    companyPackagePrefixes: readonly string[];
    /** Build timestamp (ISO8601). */
    builtAt: string;
    /** Max hop depth reached. */
    maxDepthReached: number;
    /** Closure — every file required by the entry. */
    nodes: DependencyNode[];
    /** Files in the project not reached by the closure. Downstream agents must NOT include these. */
    unrelated: UnrelatedFile[];
    /** Cycles detected during BFS (lists of relativePaths). Diagnostic only. */
    cycles: string[][];
    /** Imports that could NOT be resolved to a file (3rd-party / typo / missing source). */
    unresolvedImports: Array<{ from: string; fqn: string }>;
}

export interface BuildOptions {
    /** Cap on BFS depth. Default 8. */
    maxDepth?: number;
    /** When true, follow data-file references (xlsx → xml → properties). Default true. */
    followDataRefs?: boolean;
    /** Override the company-package prefix detection. Default: derive from entry file's package. */
    companyPackagePrefixes?: readonly string[];
}

// ============================================================================
// Internal Constants
// ============================================================================

const SOURCE_EXTS = new Set(['.java', '.cs']);
const DATA_EXTS = new Set(['.xlsx', '.xls', '.csv', '.tsv', '.json', '.xml', '.properties']);

const KNOWN_THIRD_PARTY_PREFIXES = [
    'java.', 'javax.', 'jakarta.',
    'org.openqa.', 'org.testng.', 'org.junit.', 'junit.',
    'org.openqa.selenium.', 'org.apache.', 'org.slf4j.',
    'com.google.', 'com.fasterxml.',
    'System', 'Microsoft.', 'NUnit.', 'OpenQA.',
];

// ============================================================================
// CSDependencyGraph
// ============================================================================

export class CSDependencyGraph {
    /**
     * Build the dependency graph rooted at `entryFile`. Walks the
     * project, builds the FQN index, then BFS from entry.
     */
    public static build(
        entryFile: string,
        projectRoot: string,
        opts: BuildOptions = {},
    ): DependencyGraph {
        const maxDepth = opts.maxDepth ?? 8;
        const followDataRefs = opts.followDataRefs !== false;

        // --- Index pass: walk project once, build FQN → file lookup. ---
        const allSourceFiles = CSDependencyGraph.collectSourceFiles(projectRoot);
        const allDataFiles = CSDependencyGraph.collectDataFiles(projectRoot);
        const fqnToFile = new Map<string, string>(); // FQN → abs path
        const fileToFqn = new Map<string, string>(); // abs path → FQN
        const fileHeaders = new Map<string, string>(); // abs path → first 8KB
        for (const abs of allSourceFiles) {
            const head = CSDependencyGraph.safeReadHead(abs, 8 * 1024);
            if (!head) continue;
            fileHeaders.set(abs, head);
            const pkg = CSDependencyGraph.extractPackage(head);
            const cls = CSDependencyGraph.extractClassName(head, abs);
            if (pkg && cls) {
                const fqn = `${pkg}.${cls}`;
                fqnToFile.set(fqn, abs);
                fileToFqn.set(abs, fqn);
            } else if (cls) {
                fqnToFile.set(cls, abs);
                fileToFqn.set(abs, cls);
            }
        }
        // Data files index by basename for cross-reference resolution.
        const dataByBasename = new Map<string, string[]>();
        for (const abs of allDataFiles) {
            const base = path.basename(abs);
            const list = dataByBasename.get(base) ?? [];
            list.push(abs);
            dataByBasename.set(base, list);
        }

        // --- Detect company-package prefix from the entry file (or override). ---
        const entryAbs = path.resolve(entryFile);
        const entryHead = fileHeaders.get(entryAbs) ?? CSDependencyGraph.safeReadHead(entryAbs, 8 * 1024) ?? '';
        const companyPackagePrefixes = opts.companyPackagePrefixes ??
            CSDependencyGraph.detectCompanyPackagePrefixes(entryHead, fqnToFile);

        // --- BFS from entry. ---
        const nodes = new Map<string, DependencyNode>(); // absPath → node
        const queue: Array<{ abs: string; depth: number; importerAbs?: string }> = [];
        const cycles: string[][] = [];
        const unresolvedImports: Array<{ from: string; fqn: string }> = [];

        queue.push({ abs: entryAbs, depth: 0 });

        while (queue.length > 0) {
            const { abs, depth, importerAbs } = queue.shift()!;
            if (depth > maxDepth) continue;

            const existing = nodes.get(abs);
            if (existing) {
                // Already visited — record back-edge (cycle if it appears below
                // its own depth) and stop expanding.
                if (importerAbs) {
                    const importerRel = path.relative(projectRoot, importerAbs).replace(/\\/g, '/');
                    if (!existing.importedBy.includes(importerRel)) {
                        existing.importedBy.push(importerRel);
                    }
                }
                continue;
            }

            const isData = DATA_EXTS.has(path.extname(abs).toLowerCase());
            const head = isData ? '' : (fileHeaders.get(abs) ?? CSDependencyGraph.safeReadHead(abs, 64 * 1024) ?? '');
            const fullBody = isData
                ? ''
                : (() => {
                    try { return fs.readFileSync(abs, 'utf-8'); } catch { return ''; }
                })();
            const imports = isData ? [] : CSDependencyGraph.extractCompanyImports(head + '\n' + fullBody, companyPackagePrefixes);
            const stringRefs = isData
                ? []
                : CSDependencyGraph.extractFilenameLiterals(fullBody);

            const kind = CSDependencyGraph.classifyFile(abs, projectRoot, depth, head + fullBody);
            const relativePath = path.relative(projectRoot, abs).replace(/\\/g, '/');

            const node: DependencyNode = {
                relativePath,
                absolutePath: abs,
                kind,
                depth,
                importedBy: importerAbs
                    ? [path.relative(projectRoot, importerAbs).replace(/\\/g, '/')]
                    : [],
                imports,
                references: stringRefs,
            };
            nodes.set(abs, node);

            // Resolve company imports → enqueue.
            for (const fqn of imports) {
                const target = fqnToFile.get(fqn);
                if (!target) {
                    unresolvedImports.push({ from: relativePath, fqn });
                    continue;
                }
                if (target === abs) continue; // self
                queue.push({ abs: target, depth: depth + 1, importerAbs: abs });
            }

            // Resolve filename string refs → data files.
            if (followDataRefs) {
                for (const ref of stringRefs) {
                    const base = path.basename(ref);
                    const candidates = dataByBasename.get(base) ?? [];
                    for (const candidate of candidates) {
                        if (candidate === abs) continue;
                        queue.push({ abs: candidate, depth: depth + 1, importerAbs: abs });
                    }
                }
            }

            // For data files, sniff cell values for further filename references.
            if (isData && followDataRefs) {
                const dataRefs = CSDependencyGraph.extractDataFileCellRefs(abs);
                node.references = dataRefs;
                for (const ref of dataRefs) {
                    const base = path.basename(ref);
                    const candidates = dataByBasename.get(base) ?? [];
                    for (const candidate of candidates) {
                        if (candidate === abs) continue;
                        queue.push({ abs: candidate, depth: depth + 1, importerAbs: abs });
                    }
                }
            }
        }

        // --- Cycle detection — any node appearing in its own ancestry chain. ---
        for (const node of nodes.values()) {
            const trail: string[] = [];
            const seen = new Set<string>();
            let cur: string | undefined = node.absolutePath;
            while (cur) {
                if (seen.has(cur)) {
                    const cycleStart = trail.indexOf(path.relative(projectRoot, cur).replace(/\\/g, '/'));
                    if (cycleStart !== -1) {
                        cycles.push(trail.slice(cycleStart));
                    }
                    break;
                }
                seen.add(cur);
                trail.push(path.relative(projectRoot, cur).replace(/\\/g, '/'));
                const importers = nodes.get(cur)?.importedBy ?? [];
                if (importers.length === 0) break;
                cur = path.join(projectRoot, importers[0]);
            }
        }

        // --- Compute "unrelated" — every source/data file not in closure. ---
        const closureAbsSet = new Set(nodes.keys());
        const unrelated: UnrelatedFile[] = [];
        for (const abs of [...allSourceFiles, ...allDataFiles]) {
            if (closureAbsSet.has(abs)) continue;
            unrelated.push({
                relativePath: path.relative(projectRoot, abs).replace(/\\/g, '/'),
                reason: 'not in transitive closure of entry file',
            });
        }

        const nodesList = Array.from(nodes.values()).sort((a, b) =>
            a.depth - b.depth || a.relativePath.localeCompare(b.relativePath),
        );
        const maxDepthReached = nodesList.reduce((m, n) => Math.max(m, n.depth), 0);

        return {
            entryFile: path.relative(projectRoot, entryAbs).replace(/\\/g, '/'),
            projectRoot,
            companyPackagePrefixes,
            builtAt: new Date().toISOString(),
            maxDepthReached,
            nodes: nodesList,
            unrelated,
            cycles,
            unresolvedImports,
        };
    }

    /**
     * Render the graph as a compact human-readable summary suitable for
     * `STATUS.md`. Keeps the unrelated-files reasoning explicit so
     * downstream agent prompts can quote it.
     */
    public static renderSummary(graph: DependencyGraph): string {
        const lines: string[] = [];
        lines.push(`# Dependency closure for ${graph.entryFile}`);
        lines.push('');
        lines.push(`- Project root: ${graph.projectRoot}`);
        lines.push(`- Company package prefixes: ${graph.companyPackagePrefixes.join(', ') || '(none detected)'}`);
        lines.push(`- Nodes in closure: ${graph.nodes.length} (max depth ${graph.maxDepthReached})`);
        lines.push(`- Files in project NOT in closure: ${graph.unrelated.length}`);
        lines.push(`- Unresolved imports: ${graph.unresolvedImports.length}`);
        if (graph.cycles.length > 0) lines.push(`- Cycles detected: ${graph.cycles.length}`);
        lines.push('');
        lines.push('## Closure');
        for (const n of graph.nodes) {
            const imp = n.importedBy.length > 0 ? ` ← ${n.importedBy.join(', ')}` : '';
            lines.push(`  d=${n.depth} [${n.kind}] ${n.relativePath}${imp}`);
        }
        if (graph.unresolvedImports.length > 0) {
            lines.push('');
            lines.push('## Unresolved imports (may be 3rd-party or missing source)');
            for (const u of graph.unresolvedImports.slice(0, 50)) {
                lines.push(`  ${u.fqn}  (imported by ${u.from})`);
            }
            if (graph.unresolvedImports.length > 50) {
                lines.push(`  …and ${graph.unresolvedImports.length - 50} more`);
            }
        }
        if (graph.unrelated.length > 0) {
            lines.push('');
            lines.push('## Unrelated files (do NOT include — not in closure)');
            for (const u of graph.unrelated.slice(0, 50)) {
                lines.push(`  ${u.relativePath}`);
            }
            if (graph.unrelated.length > 50) {
                lines.push(`  …and ${graph.unrelated.length - 50} more`);
            }
        }
        return lines.join('\n');
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private static collectSourceFiles(root: string): string[] {
        const out: string[] = [];
        const stack: string[] = [root];
        while (stack.length > 0) {
            const dir = stack.pop()!;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === 'target' || e.name === 'build' || e.name.startsWith('.')) continue;
                    stack.push(path.join(dir, e.name));
                } else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase())) {
                    out.push(path.join(dir, e.name));
                }
            }
        }
        return out;
    }

    private static collectDataFiles(root: string): string[] {
        const out: string[] = [];
        const stack: string[] = [root];
        while (stack.length > 0) {
            const dir = stack.pop()!;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === 'target' || e.name === 'build' || e.name.startsWith('.')) continue;
                    stack.push(path.join(dir, e.name));
                } else if (e.isFile() && DATA_EXTS.has(path.extname(e.name).toLowerCase())) {
                    out.push(path.join(dir, e.name));
                }
            }
        }
        return out;
    }

    private static safeReadHead(p: string, maxBytes: number): string | null {
        try {
            const fd = fs.openSync(p, 'r');
            try {
                const buf = Buffer.alloc(maxBytes);
                const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
                return buf.slice(0, bytesRead).toString('utf-8');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return null;
        }
    }

    private static extractPackage(head: string): string | undefined {
        // Java
        const j = /^\s*package\s+([\w.]+)\s*;/m.exec(head);
        if (j) return j[1];
        // C#
        const c = /^\s*namespace\s+([\w.]+)/m.exec(head);
        if (c) return c[1];
        return undefined;
    }

    private static extractClassName(head: string, abs: string): string | undefined {
        const j = /\b(?:public\s+|abstract\s+|final\s+|static\s+)*(?:class|interface|enum)\s+([A-Za-z_][\w]*)/m.exec(head);
        if (j) return j[1];
        return path.basename(abs).replace(/\.(java|cs)$/i, '');
    }

    private static detectCompanyPackagePrefixes(
        entryHead: string,
        fqnIndex: Map<string, string>,
    ): string[] {
        const explicit = CSDependencyGraph.extractPackage(entryHead);
        const prefixes = new Set<string>();
        if (explicit) {
            // First two segments of the entry file's package — e.g. `com.acme`.
            const parts = explicit.split('.');
            if (parts.length >= 2) prefixes.add(`${parts[0]}.${parts[1]}`);
            else prefixes.add(explicit);
        }
        // Add prefixes that show up in many indexed files (heuristic).
        const counts = new Map<string, number>();
        for (const fqn of fqnIndex.keys()) {
            const parts = fqn.split('.');
            if (parts.length < 2) continue;
            const key = `${parts[0]}.${parts[1]}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        for (const [key, count] of counts.entries()) {
            if (count >= 3 && !KNOWN_THIRD_PARTY_PREFIXES.some((p) => key.startsWith(p.replace(/\.$/, '')))) {
                prefixes.add(key);
            }
        }
        return Array.from(prefixes).sort();
    }

    private static extractCompanyImports(body: string, prefixes: readonly string[]): string[] {
        if (prefixes.length === 0) return [];
        const out = new Set<string>();
        // Java import statements.
        const javaRe = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
        let m: RegExpExecArray | null;
        while ((m = javaRe.exec(body)) !== null) {
            const fqn = m[1].replace(/\.\*$/, '');
            if (prefixes.some((p) => fqn === p || fqn.startsWith(p + '.'))) {
                if (CSDependencyGraph.isThirdParty(fqn)) continue;
                out.add(fqn);
            }
        }
        // C# using statements.
        const csRe = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm;
        while ((m = csRe.exec(body)) !== null) {
            const ns = m[1];
            if (prefixes.some((p) => ns === p || ns.startsWith(p + '.'))) {
                if (CSDependencyGraph.isThirdParty(ns)) continue;
                out.add(ns);
            }
        }
        return Array.from(out).sort();
    }

    private static isThirdParty(fqn: string): boolean {
        return KNOWN_THIRD_PARTY_PREFIXES.some((p) => fqn.startsWith(p));
    }

    /**
     * Pull filename literals from a source body — strings that look like
     * `"<name>.xlsx"` / `"<name>.xml"` / etc. These are the cell-level
     * references the user called out (helper code reading config files).
     */
    private static extractFilenameLiterals(body: string): string[] {
        const out = new Set<string>();
        const re = /(['"`])([^'"`\s]+\.(?:xlsx|xls|csv|tsv|json|xml|properties))\1/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
            out.add(m[2]);
        }
        return Array.from(out).sort();
    }

    /**
     * For data files, scan cell / element values for filename references.
     * Pulls in xlsx → xml / properties chains the user described.
     * Returns the set of referenced filenames (basename or path fragment).
     */
    private static extractDataFileCellRefs(abs: string): string[] {
        const out = new Set<string>();
        const ext = path.extname(abs).toLowerCase();
        try {
            if (ext === '.xml' || ext === '.properties' || ext === '.json' || ext === '.csv' || ext === '.tsv') {
                const text = fs.readFileSync(abs, 'utf-8');
                const re = /([\w-]+\.(?:xlsx|xls|csv|tsv|json|xml|properties))\b/gi;
                let m: RegExpExecArray | null;
                while ((m = re.exec(text)) !== null) out.add(m[1]);
                return Array.from(out).sort();
            }
            if (ext === '.xlsx' || ext === '.xls') {
                const result = CSLegacyDataReader.read(abs);
                if (result.kind === 'rows') {
                    for (const row of result.rows) {
                        for (const v of Object.values(row)) {
                            if (typeof v !== 'string') continue;
                            const matches = v.match(/[\w-]+\.(?:xlsx|xls|csv|tsv|json|xml|properties)/gi);
                            if (matches) matches.forEach((s) => out.add(s));
                        }
                    }
                }
            }
        } catch {
            // unreadable — best-effort
        }
        return Array.from(out).sort();
    }

    private static classifyFile(
        abs: string,
        projectRoot: string,
        depth: number,
        body: string,
    ): DependencyKind {
        if (depth === 0) return 'entry';
        const rel = path.relative(projectRoot, abs).replace(/\\/g, '/').toLowerCase();
        const ext = path.extname(abs).toLowerCase();
        if (DATA_EXTS.has(ext)) {
            if (ext === '.properties') return 'config';
            if (ext === '.xml' && /config|settings/i.test(rel)) return 'config';
            return 'data';
        }
        // Heuristic-by-naming + body sniff for source files.
        if (/(?:base|abstract).*(?:test|page)/i.test(rel) || /abstract\s+class/.test(body)) return 'base-class';
        if (/(?:login|signin|signon).*page/i.test(rel) || /class\s+\w*Login\w*Page\b/.test(body)) return 'login-page';
        if (/\/pages?\//.test(rel) || /class\s+\w+Page\b/.test(body)) return 'page';
        if (/\/(?:helpers?|support|utils?|util)\//.test(rel) || /class\s+\w+(?:Helper|Support|Util|Utility)\b/.test(body)) return 'helper';
        return 'unknown';
    }
}
