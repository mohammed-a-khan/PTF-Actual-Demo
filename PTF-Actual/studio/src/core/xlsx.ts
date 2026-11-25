/**
 * A small .xlsx writer (Office Open XML spreadsheet): sheets of text and numbers, a bold header row
 * that stays in view, column widths and filters. No dependency: the workbook is a ZIP of XML parts,
 * compressed with Node's zlib.
 */
import * as zlib from 'zlib';

export type Cell = string | number | boolean | null | undefined;
export interface Sheet {
    name: string;
    /** First row: column names (bold, frozen, with filters). */
    columns: string[];
    rows: Cell[][];
    /** Column widths in characters (default: from the content, 8–60). */
    widths?: number[];
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Characters XML 1.0 does not allow.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

/** A1-style column letters: 0 → A, 26 → AA. */
export function colName(i: number): string {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
}

/** Sheet names: at most 31 characters, none of : \ / ? * [ ], unique. */
function sheetNames(sheets: Sheet[]): string[] {
    const used = new Set<string>();
    return sheets.map((s, i) => {
        const base = (s.name.replace(/[:\\/?*[\]]/g, ' ').trim() || `Sheet${i + 1}`).slice(0, 31);
        let n = base;
        for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
        used.add(n.toLowerCase());
        return n;
    });
}

function cellXml(ref: string, v: Cell, style = 0): string {
    const st = style ? ` s="${style}"` : '';
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : '';
    if (typeof v === 'boolean') return `<c r="${ref}"${st} t="b"><v>${v ? 1 : 0}</v></c>`;
    const text = v.length > 32767 ? v.slice(0, 32760) + '…' : v;
    return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function sheetXml(s: Sheet): string {
    const all: Cell[][] = [s.columns, ...s.rows];
    const ncol = Math.max(1, ...all.map((r) => r.length));
    const widths = Array.from({ length: ncol }, (_, c) => s.widths?.[c] ?? Math.min(60, Math.max(8, ...all.slice(0, 500).map((r) => String(r[c] ?? '').length + 2))));
    const rows = all.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cellXml(`${colName(c)}${i + 1}`, v, i === 0 ? 1 : 0)).join('')}</row>`).join('');
    const last = `${colName(ncol - 1)}${all.length}`;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<dimension ref="A1:${last}"/>`
        + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
        + `<sheetData>${rows}</sheetData>`
        + (s.columns.length ? `<autoFilter ref="A1:${last}"/>` : '')
        + '</worksheet>';
}

/** The workbook as .xlsx bytes. */
export function xlsx(sheets: Sheet[]): Buffer {
    if (!sheets.length) throw new Error('A workbook needs at least one sheet.');
    const names = sheetNames(sheets);
    const files: Array<[string, string]> = [
        ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
            + '</Types>'],
        ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
        ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            + names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>'
            + (sheets.some((s) => s.columns.length) ? `<definedNames>${sheets.map((s, i) => (s.columns.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(names[i].replace(/'/g, "''"))}'!$A$1:$${colName(Math.max(1, s.columns.length, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length + 1}</definedName>` : '')).join('')}</definedNames>` : '')
            + '</workbook>'],
        ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
            + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
        ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>'
            + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
            + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
        ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
    ];
    return zip(files.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })));
}

// ---- ZIP (deflate), enough for an .xlsx package.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
    const parts: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    // 1980-01-01 00:00 (DOS time), so the same content gives the same bytes.
    const time = 0, date = (0 << 9) | (1 << 5) | 1;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const packed = zlib.deflateRawSync(e.data);
        const crc = crc32(e.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
        local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
        parts.push(local, name, packed);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
        c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(e.data.length, 24);
        c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
        central.push(c, name);
        offset += local.length + name.length + packed.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, end]);
}
