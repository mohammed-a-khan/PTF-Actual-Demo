/**
 * Hibernate `.hbm.xml` mapping parser.
 *
 * Parses the legacy Hibernate XML mapping format:
 *
 *   <class name="com.example.Employee" table="EMPLOYEE">
 *       <id name="id" column="EMP_ID" type="long"/>
 *       <property name="firstName" column="FIRST_NAME" length="50" not-null="true"/>
 *       <many-to-one name="department" column="DEPT_ID" class="com.example.Department"/>
 *   </class>
 *
 * We are intentionally tolerant to malformed XML (entity references, missing
 * closing tags) — many legacy hbm files have small format quirks that a strict
 * XML parser would refuse. Regex extraction is sufficient for the fact set we
 * need: class name, table, column mappings, PK, FK targets.
 */

export interface HbmColumn {
    name: string;
    column: string;
    type: string | null;
    nullable: boolean;
    length: number | null;
    isPk: boolean;
    isFk: boolean;
    fkTarget: string | null;
    lineNumber: number;
}

export interface HbmClass {
    className: string;
    tableName: string | null;
    columns: HbmColumn[];
    filePath: string;
    lineNumber: number;
}

export interface HbmParseResult {
    filePath: string;
    classes: HbmClass[];
    warnings: string[];
}

function lineOf(src: string, offset: number): number {
    let ln = 1;
    for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') ln++;
    return ln;
}

function attrs(open: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(open)) !== null) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
    return out;
}

export function parseHbmFile(filePath: string, src: string): HbmParseResult {
    const classes: HbmClass[] = [];
    const warnings: string[] = [];

    const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(src)) !== null) {
        const cAttrs = attrs(cm[1]);
        const rawName = cAttrs.name || '';
        const className = rawName.split('.').pop() || rawName;
        const tableName = cAttrs.table || null;
        const bodyStart = cm.index + cm[0].indexOf(cm[2]);
        const body = cm[2];
        const columns: HbmColumn[] = [];

        // <id ... />
        const idRe = /<id\b([^>]*)(?:\/>|>[\s\S]*?<\/id>)/gi;
        let im: RegExpExecArray | null;
        while ((im = idRe.exec(body)) !== null) {
            const a = attrs(im[1]);
            columns.push({
                name: a.name || 'id',
                column: a.column || (a.name ? a.name.toUpperCase() : 'ID'),
                type: a.type || null,
                nullable: false,
                length: a.length ? parseInt(a.length, 10) : null,
                isPk: true,
                isFk: false,
                fkTarget: null,
                lineNumber: lineOf(src, bodyStart + im.index),
            });
        }
        // <property ... />
        const pRe = /<property\b([^>]*)(?:\/>|>[\s\S]*?<\/property>)/gi;
        let pm: RegExpExecArray | null;
        while ((pm = pRe.exec(body)) !== null) {
            const a = attrs(pm[1]);
            const col = a.column || (a.name ? camelToUpperUnderscore(a.name) : 'COL');
            const len = a.length ? parseInt(a.length, 10) : null;
            columns.push({
                name: a.name || col,
                column: col,
                type: a.type || null,
                nullable: a['not-null'] !== 'true',
                length: Number.isNaN(len as number) ? null : len,
                isPk: false,
                isFk: false,
                fkTarget: null,
                lineNumber: lineOf(src, bodyStart + pm.index),
            });
        }
        // <many-to-one ... />
        const mtRe = /<many-to-one\b([^>]*)(?:\/>|>[\s\S]*?<\/many-to-one>)/gi;
        let mm: RegExpExecArray | null;
        while ((mm = mtRe.exec(body)) !== null) {
            const a = attrs(mm[1]);
            columns.push({
                name: a.name || 'ref',
                column: a.column || (a.name ? camelToUpperUnderscore(a.name) + '_ID' : 'FK_ID'),
                type: a.type || null,
                nullable: a['not-null'] !== 'true',
                length: null,
                isPk: false,
                isFk: true,
                fkTarget: a.class ? String(a.class).split('.').pop() || String(a.class) : null,
                lineNumber: lineOf(src, bodyStart + mm.index),
            });
        }
        // <one-to-many ... /> — collections don't have an FK column on THIS
        // side, so we only note it as a warning (they need a matching many-to-
        // one on the other side).
        const otmRe = /<one-to-many\b([^>]*)(?:\/>|>[\s\S]*?<\/one-to-many>)/gi;
        let om: RegExpExecArray | null;
        while ((om = otmRe.exec(body)) !== null) {
            const a = attrs(om[1]);
            warnings.push(`one-to-many association on ${className} to ${a.class || '?'} — inverse side lives on the other entity.`);
        }

        classes.push({
            className,
            tableName,
            columns,
            filePath,
            lineNumber: lineOf(src, cm.index),
        });
    }

    return { filePath, classes, warnings };
}

function camelToUpperUnderscore(name: string): string {
    return name.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toUpperCase();
}
