/**
 * A Word document (.docx, Office Open XML) from simple blocks: headings, paragraphs (runs of text, bold, colour),
 * tables (a header row, shaded rows) and PNG images. Enough for reports; opens in Word, LibreOffice and Google Docs.
 */
import { zip } from './xlsx';

export interface Run { text: string; bold?: boolean; color?: string; mono?: boolean; size?: number }
export type Block =
    | { kind: 'heading'; level: 1 | 2 | 3; text: string }
    | { kind: 'para'; runs: Run[] | string; muted?: boolean }
    | { kind: 'table'; header: string[]; rows: string[][]; shade?: (row: number) => string | undefined; widths?: number[] }
    | { kind: 'image'; png: Buffer; width: number; height: number; caption?: string }
    | { kind: 'pageBreak' };

const x = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Characters XML 1.0 does not allow.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function runXml(r: Run, muted = false): string {
    const props = [r.bold ? '<w:b/>' : '', r.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '', r.color ? `<w:color w:val="${r.color.replace('#', '')}"/>` : muted ? '<w:color w:val="6B7280"/>' : '', r.size ? `<w:sz w:val="${r.size * 2}"/>` : muted ? '<w:sz w:val="18"/>' : ''].join('');
    // Line breaks within a run.
    return r.text.split('\n').map((t, i) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`).join('');
}

const para = (inner: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`;

function tableXml(b: Extract<Block, { kind: 'table' }>): string {
    const cols = b.header.length;
    const total = 9360; // twentieths of a point: 6.5 inches
    const widths = b.widths && b.widths.length === cols ? b.widths : Array.from({ length: cols }, (_, i) => (i === 0 && cols > 2 ? 2 : 1));
    const sum = widths.reduce((a, c) => a + c, 0);
    const tw = widths.map((w) => Math.floor((w / sum) * total));
    const cell = (t: string, w: number, opts: { head?: boolean; fill?: string; right?: boolean }) =>
        `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill.replace('#', '')}"/>` : ''}</w:tcPr>`
        + `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/>${opts.right ? '<w:jc w:val="right"/>' : ''}</w:pPr>${runXml({ text: t, bold: opts.head, size: 9 })}</w:p></w:tc>`;
    // A column of numbers is right-aligned (its header too); text columns stay left-aligned.
    const num = (t: string) => /^([-+]?[\d.,]+\s*(%|ms|s|\/s)?|—)$/.test(t.trim());
    const numeric = b.header.map((_, i) => i > 0 && b.rows.length > 0 && b.rows.every((r) => num(r[i] ?? '')));
    const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${b.header.map((h, i) => cell(h, tw[i], { head: true, fill: 'F2F4F7', right: numeric[i] })).join('')}</w:tr>`;
    const rows = b.rows.map((r, k) => `<w:tr>${r.map((c, i) => cell(c, tw[i], { fill: b.shade?.(k), right: numeric[i] })).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${['top', 'bottom', 'insideH'].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="E5E7EB"/>`).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>`
        + `<w:tblGrid>${tw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${rows}</w:tbl>${para('')}`;
}

function imageXml(rid: string, n: number, wPx: number, hPx: number): string {
    // EMUs: 9525 per pixel at 96 dpi; at most the text width (6.5 in).
    const maxW = 6.5 * 914400;
    let cx = wPx * 9525, cy = hPx * 9525;
    if (cx > maxW) { cy = Math.round((cy * maxW) / cx); cx = maxW; }
    return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Chart ${n}"/>`
        + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="chart${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
        + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
        + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

export function docx(blocks: Block[], o: { title?: string } = {}): Buffer {
    const media: Array<{ name: string; data: Buffer; rid: string }> = [];
    const body = blocks.map((b) => {
        switch (b.kind) {
            case 'heading': return para(runXml({ text: b.text }), `Heading${b.level}`);
            case 'para': return para((typeof b.runs === 'string' ? [{ text: b.runs }] : b.runs).map((r) => runXml(r, b.muted)).join(''));
            case 'table': return tableXml(b);
            case 'pageBreak': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
            case 'image': {
                const n = media.length + 1, rid = `rIdImg${n}`;
                media.push({ name: `media/chart${n}.png`, data: b.png, rid });
                return imageXml(rid, n, b.width, b.height) + (b.caption ? para(runXml({ text: b.caption, size: 8, color: '6B7280' })) : '');
            }
        }
    }).join('');
    const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
        + `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const heading = (n: number, size: number, before: number) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>'
        + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        + heading(1, 36, 0) + heading(2, 26, 280) + heading(3, 22, 180) + '</w:styles>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.name}"/>`).join('') + '</Relationships>';
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    const root = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
    const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:title>${x(o.title ?? '')}</dc:title><dc:creator>CS Test Studio</dc:creator></cp:coreProperties>`;
    return zip([
        { name: '[Content_Types].xml', data: Buffer.from(types) }, { name: '_rels/.rels', data: Buffer.from(root) }, { name: 'docProps/core.xml', data: Buffer.from(core) },
        { name: 'word/document.xml', data: Buffer.from(document) }, { name: 'word/styles.xml', data: Buffer.from(styles) }, { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels) },
        ...media.map((m) => ({ name: `word/${m.name}`, data: m.data })),
    ]);
}
