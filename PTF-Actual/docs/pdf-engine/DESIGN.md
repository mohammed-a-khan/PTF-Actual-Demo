# CS PDF Engine — Design Document

| | |
|---|---|
| **Status** | Draft for review |
| **Owner** | mohammed-a-khan |
| **Module** | `PTF-Actual/src/pdf/` (published as subpath `@mdakhan.mak/cs-playwright-test-framework/pdf`) |
| **Replaces** | `pdfjs-dist` for text, geometry and document-structure extraction in `src/report-validation` |
| **Background** | `reports/Zero dependency PDF to JSON.md` (research report) |

---

## 1. Summary

We will build our own PDF-to-JSON engine, written **from scratch in TypeScript** and using **only Node.js built-in modules** (`Buffer`, `fs`, `zlib`, `crypto`). It reads a PDF and returns a fully typed JSON document containing:

- metadata
- page geometry
- text, at the glyph level and as spans
- real font information (name, bold, italic, embedded)
- text colour
- ruling lines and rectangles
- annotations and links
- outline (bookmarks)

The engine is a **general-purpose library that must work on any PDF**, whatever its producer, PDF version, fonts, language or script, and including encrypted and damaged files. It has a public API and a CLI. Business-report PDFs from SSRS and Crystal Reports are its first consumer (`src/report-validation`, which today depends on `pdfjs-dist` v4; that dependency is undeclared in `package.json`). They are one target among many, not a special case. The reference corpus in `test/pdf/corpus/` is what defines "any PDF": 985 real files from more than 40 producer families, 26 feature and failure buckets and 25 languages.

### 1.1 Principles

1. **Clean room.** The code is written from the published specifications:
   - ISO 32000-1:2008 (PDF 1.7) and ISO 32000-2 (PDF 2.0)
   - the TrueType/OpenType specification, for the `cmap` and `post` tables
   - the Adobe Glyph List *Specification*, for the naming algorithm

   No source code is copied, ported or translated from pdf.js, pdfminer, pypdf, PDFBox, MuPDF or any other implementation. While implementing, contributors work from the specifications, not from other parsers' source code.
2. **No runtime dependencies.** Only Node built-ins. Nothing is added to `dependencies` or `peerDependencies`.
3. **Reference data from the official sources.** The Adobe Glyph List and the Core-14 font metrics (AFM) are used as standard reference data, in the same way as Unicode tables.
   - Our own script (`scripts/pdf-engine/generate-reference-data.js`) converts the raw Adobe files into compact TypeScript tables.
   - Adobe's copyright and permission notices are kept next to the data and in `THIRD-PARTY-NOTICES.md`.
   - The encoding tables (Standard, WinAnsi, MacRoman, PDFDoc, MacExpert, Symbol, ZapfDingbats) are typed in from ISO 32000-1 Annex D.
4. **Correct and honest output.**
   - Every value has a defined unit and coordinate system.
   - Every fallback is recorded, for example "Unicode guessed from glyph name" or "xref rebuilt by scanning".
   - Nothing fails silently.
5. **Safe on untrusted input.** The engine never uses `eval` or `new Function`. It enforces limits on decompressed size, object count, recursion depth and time.
6. **The engine is ours, so grouping is ours.** We do not imitate another library's text-item boundaries. The engine exposes glyph-level truth, and our own documented, configurable algorithms build words, lines and spans from it.

### 1.2 Non-goals (v1)

- Rendering pages to pixels. The barcode, visual-regression, image-inventory and OCR checks still need a renderer; see §11.
- Decoding image pixel data (DCT/JPX/JBIG2/CCITT). Images are reported by size, filter and position only.
- Editing or writing PDFs. A tiny PDF *writer* exists only in the test tooling, to generate fixtures.
- OCR of image-only pages. Scanned PDFs that carry an invisible OCR text layer, as most scanner output does, are fully supported. Pages with no text layer at all are reported as `imageOnly: true`.

The following are **in scope** because the engine must handle any PDF. They are scheduled in milestone M5b (§10):
- CJK predefined CMaps (`90ms-RKSJ-H`, `GBK-EUC-H`, `UniJIS-UCS2-H` and similar) and the Adobe CID→Unicode collections (Japan1, GB1, CNS1, Korea1). Our script generates these from Adobe's published CMap resources, in the same way as the other reference data. They are loaded lazily, only when a document uses them.
- Vertical writing (`Identity-V`, `W2`/`DW2`).
- Right-to-left text: a per-span direction, plus logical-order reconstruction for Arabic, Hebrew and Persian using our own implementation of the Unicode Bidirectional Algorithm (UAX #9).
- Complex scripts such as Devanagari, Thai and Bengali, decoded through ToUnicode and the embedded `cmap`, with `ActualText` preferred where it is present.
- Type 3 fonts (TeX bitmap fonts, some generators) and Type 1 / CFF embedded fonts. Glyph names come from the font program when the PDF dictionary lacks them.

---

## 2. Goals and success criteria

| # | Goal | Measured by |
|---|---|---|
| G0 | Works on **any PDF** | Across the 985-file corpus, every file either parses or fails with a typed error. Measured against a reviewed baseline, text recall is ≥ 99 % on files whose fonts have a usable Unicode source, and every unmappable glyph is reported with `unicodeSource: "unknown"` rather than as wrong text |
| G1 | Correct text for the user's SSRS / Crystal / Chromium-`page.pdf()` reports | 100 % character match on golden fixtures from those producers |
| G2 | Exact geometry | Glyph origins within ±0.01 pt of hand-computed values on synthetic fixtures; span widths within ±0.05 pt |
| G3 | Report-validation keeps working | Every existing report-validation scenario passes on the native engine; `analyzeReport` output reviewed and approved per fixture |
| G4 | Robust | Every PDF in our fixture and corpus suites either parses or fails with a typed error. No hangs, no unbounded memory, and the fuzzer finds no crashes |
| G5 | Fast | Equal to or faster than pdfjs-dist on the same machine, on the benchmark set (target: under 50 ms per typical report page) |
| G6 | Developer experience | One-line API, full `.d.ts` types, JSON Schema file, CLI, docs with examples, clear error codes |

---

## 3. Architecture

The engine is built as seven layers. Each layer depends only on the layers below it, and each has its own unit tests.

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ L6  API / CLI           parsePdf(), openPdf(), cs-pdf-to-json CLI, JSON │
 ├─────────────────────────────────────────────────────────────────────────┤
 │ L5  Layout              spans → words → lines → (optional) blocks;      │
 │                         ruling lines/rects; pdfjs-compatible adapter    │
 ├─────────────────────────────────────────────────────────────────────────┤
 │ L4  Content interpreter graphics state, text state, matrices, glyph     │
 │                         emission, Form XObjects, marked content, paths  │
 ├─────────────────────────────────────────────────────────────────────────┤
 │ L3  Fonts & text        font dicts, encodings, ToUnicode CMaps, glyph   │
 │                         names→Unicode, widths, embedded TrueType/CFF/T1 │
 ├─────────────────────────────────────────────────────────────────────────┤
 │ L2  Document model      catalog, page tree + inheritance, Info/XMP,     │
 │                         outline, page labels, annotations, names        │
 ├─────────────────────────────────────────────────────────────────────────┤
 │ L1  Object store        xref tables/streams, incremental updates,       │
 │                         object streams, recovery scan, encryption       │
 ├─────────────────────────────────────────────────────────────────────────┤
 │ L0  Bytes & syntax      byte reader, lexer, object parser, stream       │
 │                         filters (zlib-backed Flate, LZW, A85, AHx, RL,  │
 │                         predictors)                                     │
 └─────────────────────────────────────────────────────────────────────────┘
```

**Lazy by default.** Objects are parsed when first requested and then cached. A page's content is interpreted only when that page is requested, so `openPdf()` followed by `getPage(7)` never touches pages 1–6.

### 3.1 Source layout

```
src/pdf/
  index.ts                      public exports
  api/
    CSPdf.ts                    parsePdf(), openPdf(): main entry points
    CSPdfOptions.ts             options + defaults + limits
    CSPdfJson.ts                output types (the JSON contract)
    CSPdfErrors.ts              typed errors + warning codes
  syntax/                       L0
    CSPdfByteReader.ts          position-tracking reader over Buffer
    CSPdfLexer.ts               tokens: numbers, names, strings, keywords, delimiters
    CSPdfObjects.ts             PdfName, PdfRef, PdfDict, PdfArray, PdfStream, PdfString
    CSPdfObjectParser.ts        objects, indirect objects, streams (incl. bad /Length)
  filters/                      L0
    CSPdfFilterChain.ts         applies /Filter + /DecodeParms arrays
    CSFlateDecode.ts            zlib wrapper with tolerant fallbacks
    CSPredictors.ts             PNG 10–15, TIFF 2
    CSLzwDecode.ts              incl. EarlyChange
    CSAscii85Decode.ts
    CSAsciiHexDecode.ts
    CSRunLengthDecode.ts
  store/                        L1
    CSXrefTable.ts              classic xref sections
    CSXrefStream.ts             /Type /XRef streams (/W, /Index)
    CSXrefResolver.ts           startxref, /Prev chains, hybrid /XRefStm, loop guards
    CSXrefRecovery.ts           full-file scan rebuild
    CSObjectStream.ts           /Type /ObjStm
    CSObjectStore.ts            fetch(ref), cache, limits
  security/                     L1
    CSStandardSecurity.ts       Standard handler R2–R6, key derivation
    CSRc4.ts                    our own RC4 (OpenSSL 3 disables it)
    CSCryptFilters.ts           V4/V5 crypt filters, /Identity
  document/                     L2
    CSPdfCatalog.ts             /Root, version, lang, names, viewer prefs
    CSPageTree.ts               walk, inheritance, rotation/boxes normalisation
    CSDocumentInfo.ts           Info dict, PDF dates, text strings (PDFDoc/UTF-16/UTF-8)
    CSXmpMetadata.ts            raw XMP + a few well-known fields
    CSOutline.ts                bookmarks + destinations
    CSPageLabels.ts
    CSAnnotations.ts            links, widgets (form fields), text annotations
  fonts/                        L3
    CSFontFactory.ts            builds a CSFont from a font dictionary (cached per ref)
    CSFont.ts                   interface: decode(bytes) → glyphs (code, unicode, width)
    CSSimpleFont.ts             Type1 / TrueType / MMType1
    CSType0Font.ts              composite fonts, CIDFont W/DW/W2/DW2
    CSType3Font.ts              FontMatrix, CharProcs widths
    CSCMapParser.ts             ToUnicode + embedded CMaps (codespace, bfchar, bfrange)
    CSEncodings.ts              typed-in Annex D tables + Differences
    CSGlyphNames.ts             glyph name → Unicode (AGL spec algorithm + data)
    CSStandardFonts.ts          Core-14 metrics lookup + name aliases
    CSFontFlags.ts              FontDescriptor flags, bold/italic inference
    embedded/
      CSTrueTypeReader.ts       table directory, cmap (0/4/6/12), post (1/2/3), OS/2, head
      CSCffReader.ts            charset + encoding only (glyph names for CFF/Type1C)
      CSType1Reader.ts          cleartext /Encoding of embedded Type1
  content/                      L4
    CSContentLexer.ts           operand/operator stream, inline-image skipping
    CSGraphicsState.ts          CTM, q/Q stack, colour state, line width
    CSTextState.ts              Tc Tw Tz TL Tf Tr Ts, Tm/Tlm
    CSContentInterpreter.ts     operator dispatch, Do recursion, BX/EX
    CSGlyphEmitter.ts           Trm per glyph → CSGlyph records
    CSPathCollector.ts          m l c v y h re + S s f F B b n → segments/rects
    CSMarkedContent.ts          BMC/BDC/EMC, MCID, /ActualText
  layout/                       L5
    CSSpanBuilder.ts            glyphs → spans (same font/size/colour/baseline, contiguous)
    CSWordBuilder.ts            spans → words (space glyphs + geometric gaps)
    CSLineBuilder.ts            words → lines (baseline clustering, rotation-aware)
    CSRulingExtractor.ts        merge collinear segments, thin rects → rulings
    CSTextNormalizer.ts         ligature expansion, NFKC subset, whitespace
    CSPdfJsCompat.ts            produces the existing PdfJsTextItem / TextItem shapes
  data/                         GENERATED by scripts/pdf-engine/*, do not hand-edit
    glyphlist.data.ts
    core14-metrics.data.ts
    NOTICE-adobe.txt
  cli/
    cs-pdf-to-json.ts           CLI entry
scripts/pdf-engine/
  generate-reference-data.js   raw Adobe files → data/*.ts (run manually, output committed)
  raw/                          glyphlist.txt, Core14 AFM files + ReadMe (as published)
test/pdf/                       see §9
docs/pdf-engine/
  DESIGN.md                     this document
  USER-GUIDE.md                 API + CLI + JSON reference (written in M6)
  json-schema/cs-pdf.schema.json
```

---

## 4. Layer details

### L0 Bytes and syntax (ISO 32000-1 §7.2–7.3)

- **Lexer.** Tokenises against the spec's character classes: whitespace (NUL, HT, LF, FF, CR, SP) and delimiters (`( ) < > [ ] { } / %`).
  - Literal strings support balanced parentheses, the escapes `\n \r \t \b \f \( \) \\`, octal `\ddd` and line continuation.
  - Hex strings ignore whitespace and treat an odd final digit as followed by 0.
  - Names decode `#xx`.
  - Numbers are lenient: `--5`, `5.`, `.5`, and `-` alone are accepted, and each is recorded as a warning.
- **Object parser.** Handles indirect objects (`n g obj … endobj`) and references (`n g R`).
- **Streams.**
  - The EOL after `stream` is CRLF or LF; a lone CR is tolerated with a warning.
  - `/Length` may be an indirect reference.
  - If the data at `offset + Length` is not followed by `endstream`, the parser scans forward for `endstream` and records `STREAM_LENGTH_FIXED`.
- **Filters** (§7.4). Chained in array order, each with its own `DecodeParms`.

  | Filter | Implementation |
  |---|---|
  | FlateDecode | `zlib.inflateSync`, with fallbacks in this order: strip leading CR/LF; `finishFlush: Z_SYNC_FLUSH` for truncated data; raw inflate of the stream minus its 2-byte header for a bad checksum. Always uses `maxOutputLength = limits.maxStreamBytes`. Each fallback used is recorded as a warning. |
  | Predictors | Our own PNG (None/Sub/Up/Average/Paeth, per-row tag) and TIFF 2. |
  | LZWDecode | Our own implementation, 9–12-bit codes, with `EarlyChange`. |
  | ASCII85 / ASCIIHex / RunLength | Our own implementations. |
  | Image filters (DCT, JPX, CCITT, JBIG2) | Not decoded. The raw bytes are returned with a flag. |
  | Crypt | Delegated to the security layer. |

### L1 Object store (§7.5, §7.6)

- **Locating the xref.** Find `startxref` in the last 1,024 bytes, then search further back if it isn't there.
- **Classic xref tables.** 20-byte entries, parsed as tokens so that bad line endings don't break the parse. A subsection that starts at 1 where it should start at 0 is detected and corrected.
- **Xref streams.**
  - `/W` widths are big-endian.
  - `/Index` defaults to `[0 Size]`.
  - Entry types are 0 (free), 1 (byte offset) and 2 (in an object stream).
- **Incremental updates.** Follow the `/Prev` chain, with newest entries winning. A visited-offset set guards against loops. Hybrid files with `/XRefStm` are handled.
- **Object streams** (§7.5.7). Read `/N` and `/First`, parse the offset header, and cache the parsed stream.
- **Recovery.** Triggered when the xref is missing or broken, or when an offset doesn't point to `n g obj`.
  1. Scan the whole file for `n g obj` headers; the last definition of an object wins.
  2. Collect every `trailer` and every `/Type /XRef` stream.
  3. Choose the trailer whose `/Root` resolves to a catalog with a valid `/Pages`.
  4. Record `XREF_RECOVERED`.
- **Encryption** (Standard security handler, §7.6.3–7.6.4).
  - R2–R4: RC4 40–128 and AESV2. Uses our own `CSRc4`, plus `crypto` for MD5 and AES-128-CBC with manual padding removal.
  - R5/R6: AESV3, using the SHA-256/384/512 hardened hash and `/UE` / `/OE` key unwrap with AES-256.
  - The empty user password is tried first; this is the owner-password-only case typical of report servers. An optional `password` option is also accepted.
  - Per-object keys are computed for V<5.
  - Not decrypted: the `/Encrypt` dictionary, xref streams, `/ID`, and strings inside object streams.
  - With `EncryptMetadata false`, the metadata stream is not decrypted.
- **Limits.** `maxObjects`, `maxStreamBytes`, `maxTotalBytes`, `maxDepth` and `timeBudgetMs` are all configurable. Exceeding one raises a typed `CSPdfLimitError`.

### L2 Document model (§7.7, §12, §14.3)

- **Page tree.**
  - Depth-first walk with a visited set.
  - Inherited attributes: `Resources`, `MediaBox`, `CropBox`, `Rotate`.
  - `Rotate` is normalised to 0, 90, 180 or 270.
  - The visible box is `CropBox ∩ MediaBox`.
  - `UserUnit` is supported.
  - A missing `/Count` is tolerated.
- **Text strings** (§7.9.2).
  - A UTF-16BE BOM means UTF-16BE.
  - A UTF-8 BOM means UTF-8 (PDF 2.0).
  - Otherwise the bytes are decoded as PDFDocEncoding, from the typed-in Annex D table.
- **Dates.** `D:YYYYMMDDHHmmSSOHH'mm'`, parsed leniently and emitted as both raw and ISO-8601.
- **XMP.** The raw XML is returned. `dc:title`, `dc:creator`, `xmp:CreateDate` and `pdf:Producer` are also extracted with a small purpose-built XML reader.
- **Outline, page labels, named and explicit destinations, annotations.** For annotations, the engine returns subtype, rect, URI/destination, contents, and form-field name and value. Text drawn by appearance streams is optional, behind `includeAnnotationText`.

### L3 Fonts and text decoding (§9.5–9.10)

**Decoding chain, per character code.** The step that succeeded is recorded per glyph as `unicodeSource`.

1. **ToUnicode CMap.** The CMap parser handles:
   - `begincodespacerange` with variable-length codes of 1–4 bytes;
   - `bfchar`, and both forms of `bfrange` (incrementing destination, and array destination);
   - UTF-16BE destinations, including surrogate pairs and multi-character ligatures;
   - `usecmap` for Identity only.
2. **Simple fonts.**
   1. Start from a base encoding: the explicit `/Encoding`, or the font's built-in encoding.
   2. Apply `/Differences`.
   3. Convert the glyph name to Unicode, using the Adobe Glyph List algorithm we implement ourselves:
      - strip any suffix after the first `.`;
      - split on `_` for ligatures;
      - look the name up in the glyph list;
      - accept `uniXXXX…` and `uXXXX[XX]` forms.
3. **Embedded font program.** Read the TrueType `cmap` (3,1), (1,0) or (3,0) with the 0xF000 offset, or the `post` table glyph names, or the CFF charset, or the Type1 cleartext encoding.
4. **Type0 fonts.**
   - Identity-H/V gives 2-byte CIDs.
   - `Uni*-UCS2-*` and `Uni*-UTF16-*` encodings are decoded directly as UTF-16BE.
   - Otherwise the engine falls back to the embedded TrueType `cmap` via `CIDToGIDMap`.
5. **Last resort.** Emit U+FFFD, mark the glyph `unicodeSource: "unknown"`, and add a font-level quality warning.

**Widths, used for exact advances.**
- Simple fonts: `/Widths` with `FirstChar`/`LastChar`, then `MissingWidth`, then Core-14 AFM metrics for unembedded standard fonts and their aliases (Arial→Helvetica, TimesNewRoman→Times, CourierNew→Courier), then the embedded font's own advance widths.
- CID fonts: `/W` in both forms, and `/DW` (default 1000). Vertical text uses `/W2` and `/DW2`.
- Type3 fonts: widths come from `/Widths × FontMatrix`.

**Font facts exposed to callers.**
- `baseFont`, with the subset prefix stripped and also kept raw.
- `subtype`, `embedded`, `encoding`, `hasToUnicode`.
- `bold`, from FontDescriptor `ForceBold`, `/FontWeight ≥ 600`, or name patterns such as `Bold`, `Black`, `Heavy` or `,Bold`.
- `italic`, from the `Italic` flag, a non-zero `ItalicAngle`, or name patterns such as `Italic` or `Oblique`.
- `ascent`, `descent`, and a `fontId` that is stable within the document.

### L4 Content interpreter (§7.8, §8.4, §8.10, §9.3–9.4, §14.6)

- **Operators handled:**
  - graphics state: `q Q cm w J j M d ri i gs`;
  - colour: `CS cs SC SCN sc scn G g RG rg K k`, converted to an RGB hex string (DeviceGray, DeviceRGB, DeviceCMYK with a naive conversion, and the ICCBased alternate);
  - text: `BT ET Tc Tw Tz TL Tf Tr Ts Td TD Tm T* Tj TJ ' "`;
  - paths: `m l c v y h re S s f F f* B B* b b* n W W*`;
  - `Do` for Form XObjects, with `/Matrix`, `/Resources` falling back to the parent's, and a recursion guard;
  - marked content: `BMC BDC EMC MP DP`, tracking MCID and `/ActualText`;
  - `BI ID EI` inline images, skipped safely;
  - `BX EX`, so unknown operators inside are ignored without error.
- **Text math, as defined in §9.4.4:**
  - `Trm = [Tfs·Th 0 0 Tfs 0 Trise] × Tm × CTM`
  - horizontal advance `tx = ((w0 − Tj/1000)·Tfs + Tc + Tw)·Th`, where `Tw` applies only to a single-byte code 32
  - vertical-writing advance `ty`, as defined in the same section
  - `Tz` scales `Tc`, `Tw` and the `TJ` offsets
- **Glyph record emitted (`CSGlyph`):**
  - `unicode`, `code`, `unicodeSource`
  - `x`, `y` (baseline origin, in user space), `advance`
  - `fontSize` (effective, i.e. `hypot(Trm[2], Trm[3])`), `rotation`, `fontId`
  - `color`, `renderMode` (so mode-3 invisible OCR text can be filtered), `mcid`, `actualText`
- **Paths.** Collected in user space after the CTM is applied. Stroked segments and filled or stroked rectangles are kept; clip-only paths (`n`) are dropped.

### L5 Layout (our own algorithms)

These algorithms are designed by us, documented here, and fully configurable. All thresholds are expressed relative to the effective font size `fs`, so they behave the same at any zoom.

1. **Spans.** Consecutive glyphs belong to the same span when they share font, size, colour, render mode and rotation. Their baselines must lie within `0.1·fs`. The gap between one glyph's end and the next glyph's start must fall within the range `[−0.25·fs, spanGap·fs]`, where `spanGap` defaults to 0.25.
2. **Spaces.** A real space glyph (Unicode U+0020 or similar) always splits words but stays within the span. When a gap is at least `wordGap·fs` (default 0.15) and there is no space glyph, a virtual space is inserted and flagged `synthetic: true`.
3. **Columns.** A gap of at least `cellGap·fs` (default 0.6) always ends the span. This is the boundary table cells depend on, and it is an explicit, documented option.
4. **Lines.** Spans are clustered by baseline (tolerance `0.25·fs`) within the same rotation and ordered by x. Each line records `hasEOL` and the gap to the next line.
5. **Rulings.**
   - Collinear stroked segments are merged, with tolerance 0.5 pt.
   - Rectangles thinner than 1.5 pt are treated as lines.
   - Output is horizontal and vertical rulings, plus filled cell rectangles. This gives the layout analyzer real grid lines for SSRS and Crystal tables in future.
6. **Normalisation.**
   - Ligatures U+FB00–FB06 are expanded.
   - NBSP and other space variants become U+0020.
   - NFKC is applied through `String.prototype.normalize`, but only to those selected ranges.
   - The original text is kept as `rawStr` when it differs.

**Compatibility adapter (`CSPdfJsCompat`).** Produces the existing `PdfJsTextItem`, `TextItem` and `PageContent` shapes from spans, so `CSReportPdfExtractor` and the layout analyzer work unchanged on day one.
- `fontName` is the engine's opaque `fontId`, as it is today.
- `color` is now filled in.
- The real font name, bold and italic are available through new optional fields.
- Any thresholds in the layout analyzer that were tuned to pdfjs's item boundaries are revisited per fixture in milestone M5.

---

## 5. Public API

```ts
import { parsePdf, openPdf } from '@mdakhan.mak/cs-playwright-test-framework/pdf';

// One-shot: whole document → JSON
const doc = await parsePdf('report.pdf', {          // path | Buffer | Uint8Array
  password: undefined,                              // tried after empty password
  pages: 'all',                                     // 'all' | number[] | { from, to }
  include: { glyphs: false, spans: true, words: false, lines: true,
             rulings: true, annotations: true, outline: true, xmp: true },
  layout: { spanGap: 0.25, wordGap: 0.15, cellGap: 0.6, lineTolerance: 0.25 },
  limits: { maxStreamBytes: 256 * 2 ** 20, maxObjects: 2_000_000, timeBudgetMs: 60_000 },
  strict: false,                                    // true: throw instead of recover
});

// Lazy: open once, pull pages on demand
const pdf = await openPdf(buffer);
pdf.info;                        // metadata, no page work done
const page = await pdf.getPage(3);
const text = await pdf.getText({ pages: [3] }); // plain text in reading order
await pdf.close();
```

- **Errors.** `CSPdfError` carries a `code`, for example:
  - `INVALID_HEADER`
  - `ENCRYPTED_NEEDS_PASSWORD`
  - `UNSUPPORTED_SECURITY_HANDLER`
  - `LIMIT_EXCEEDED`
  - `CORRUPT_UNRECOVERABLE`

  Each error also carries `offset` and `objectRef` where known.
- **Warnings.** Non-fatal recoveries go to `doc.warnings[]`, each with a `code`, `message`, and optionally `page` and `objectRef`.
- **CLI.**
  - `npx cs-pdf-to-json report.pdf -o report.json`
  - `--pages 1-3 --glyphs --pretty --password ***`
  - `--text` prints plain text instead of JSON.

  This is a new `bin` entry in `package.json`.

---

## 6. JSON output contract (schema v1)

The TypeScript interfaces in `api/CSPdfJson.ts` are the source of truth. `docs/pdf-engine/json-schema/cs-pdf.schema.json` is generated from them.

- **Coordinates.** PDF user space, in points (1/72 inch), with the origin at the bottom-left of the visible box and y increasing upward. This matches today's `TextItem`.
- **Top-down coordinates.** Each page also gives `viewTransform`, the matrix that converts to a top-left, rotation-applied view. Callers who want top-down coordinates apply it, or set `coordinates: 'top-left'`.

```jsonc
{
  "schemaVersion": "1.0",
  "engine": { "name": "cs-pdf", "version": "1.0.0" },
  "document": {
    "pdfVersion": "1.7", "pageCount": 12, "linearized": false,
    "encryption": { "encrypted": true, "handler": "Standard", "revision": 4, "method": "AESV2",
                    "userPasswordRequired": false,
                    "permissions": { "print": true, "copy": true, "modify": false, "annotate": false,
                                     "fillForms": true, "extract": true, "assemble": false, "printHighRes": true } },
    "id": ["9f2c…", "9f2c…"],
    "info": { "title": "Market Value Detail", "author": null, "producer": "Microsoft Reporting Services PDF Rendering Extension",
              "creator": null, "creationDate": "2026-10-01T09:12:00+01:00", "modDate": null, "raw": { } },
    "xmp": { "raw": "<x:xmpmeta…>", "title": "…", "createDate": "…" },
    "lang": "en-US",
    "outline": [ { "title": "Summary", "page": 1, "url": null, "children": [] } ],
    "pageLabels": null,
    "attachments": [ { "name": "data.csv", "size": 1234, "mime": "text/csv" } ],
    "hasForms": false, "hasJavaScript": false
  },
  "fonts": [
    { "id": "F1", "baseFont": "Arial-BoldMT", "rawBaseFont": "ABCDEF+Arial-BoldMT",
      "subtype": "TrueType", "embedded": true, "encoding": "WinAnsiEncoding",
      "hasToUnicode": true, "bold": true, "italic": false, "monospace": false,
      "ascent": 0.905, "descent": -0.212, "unicodeQuality": "exact" }   // exact | inferred | partial | unknown
  ],
  "pages": [ {
    "number": 1, "label": null, "width": 612, "height": 792, "rotation": 0,
    "mediaBox": [0, 0, 612, 792], "cropBox": [0, 0, 612, 792], "userUnit": 1,
    "viewTransform": [1, 0, 0, -1, 0, 792],
    "spans": [ {
      "str": "Total Market Value", "x": 72, "y": 700.2, "width": 96.71, "height": 10,
      "fontSize": 10, "fontId": "F1", "rotation": 0, "dir": "ltr", "color": "#000000",
      "renderMode": 0, "hasEOL": false, "mcid": null,
      "transform": [10, 0, 0, 10, 72, 700.2]          // Trm of first glyph, for pdfjs-style consumers
    } ],
    "lines": [ { "y": 700.2, "x": 72, "width": 468, "spanIndexes": [0, 1, 2] } ],
    "glyphs": null,                                     // [{u, code, x, y, adv, fs, f, src}] when requested
    "rulings": {
      "horizontal": [ { "x1": 72, "x2": 540, "y": 690, "width": 0.5, "color": "#000000" } ],
      "vertical":   [ { "x": 300, "y1": 600, "y2": 690, "width": 0.5, "color": "#000000" } ],
      "fills":      [ { "x": 72, "y": 600, "w": 468, "h": 12, "color": "#eeeeee" } ]
    },
    "images": [ { "x": 400, "y": 720, "w": 120, "h": 40, "filter": "DCTDecode", "bpc": 8, "pxW": 600, "pxH": 200 } ],
    "annotations": [ { "subtype": "Link", "rect": [72, 650, 200, 662], "url": "https://…", "dest": null } ]
  } ],
  "warnings": [ { "code": "STREAM_LENGTH_FIXED", "message": "…", "objectRef": "12 0", "page": null } ]
}
```

---

## 7. Integration with report-validation

The engine **replaces pdfjs-dist inside the existing report-validation module**. It is not a second validation stack. `VERIFICATION-DESIGN.md` has the full plan; the key points are:

1. A single `CSPdfDocumentProvider` in `src/report-validation` becomes the only place a PDF is opened. It replaces the 14 private pdfjs imports (extractor, spec generator and 12 checks).
   - With `REPORT_PDF_ENGINE=native`, it serves our engine through `CSPdfJsCompat`. This is a pdfjs-compatible adapter for the API surface the module actually uses, so the code above it doesn't change.
   - `pdfjs` keeps today's behaviour, as a rollback until the next major version.
   - `dual` runs both engines, **returns the pdfjs result**, and writes `<run>/report-validation/engine-diff.json`.
2. Golden output for every existing mode is captured on pdfjs **before** the swap. `native` becomes the default only when it reproduces that output. The only allowed differences are documented improvements.
3. Rendering for barcode, visual regression and OCR goes through Playwright Chromium. Image inventory reads image XObjects straight from the engine.
4. The header comment in `CSReportPdfExtractor.ts` calls pdfjs "MIT", but it is Apache-2.0; fix it.
5. After the swap, `pdfjs-dist` is no longer used. It was never declared in `package.json`, so there is no dependency entry to remove.

---

## 8. Robustness, security and performance

| Concern | Design |
|---|---|
| Malformed files | Each layer has a lenient path that records a warning. `strict: true` turns every warning into an error. |
| Zip bombs | `maxOutputLength` on every inflate call, plus a running `maxTotalBytes` across the document. |
| Infinite loops | Visited sets on `/Prev`, the page tree, Form XObjects, `/Parent`, outline `/Next` and `usecmap`. Depth limits apply to nested arrays and dictionaries. |
| Hangs | `timeBudgetMs` is checked in the interpreter loop and the recovery scan. |
| Code execution | Nothing is evaluated. PDF JavaScript is only detected and reported, never run. |
| Memory | Lazy objects; `close()` drops caches. `openPdf` reads pages on demand. A streaming file reader is deferred unless benchmarks need it. |
| Speed | Byte-level lexer working on `Buffer` with no regex in hot paths. Fonts and CMaps are cached per indirect reference. Typed arrays are used for predictors and LZW. Benchmarks run in CI. |

---

## 9. Testing strategy

All tests use Node's built-in **`node:test` + `node:assert`**, so no test-framework dependency is added. They run with `node --test dist-test/**/*.test.js` after `tsc -p tsconfig.test.json`.

1. **Unit tests per module.**
   - Lexer edge cases.
   - Each filter, against vectors we generate with `zlib`, and with hand-computed predictor and LZW outputs.
   - The xref variants.
   - Each encryption revision, with test vectors we compute ourselves using `crypto`.
   - CMap forms.
   - The text-matrix math, against hand calculations.
2. **Our own fixture writer** (`test/pdf/tools/CSTestPdfWriter.ts`). This is a small builder that writes valid and deliberately broken PDFs from code, which gives full control over every edge case. Examples:
   - classic versus stream xref;
   - incremental updates;
   - object streams;
   - wrong `/Length`;
   - truncated Flate;
   - RC4, AESV2 and AESV3 encryption;
   - WinAnsi + Differences;
   - Identity-H + ToUnicode;
   - Type3;
   - rotated pages;
   - Form XObjects;
   - `Tz`, `Tc`, `Tw`, `TJ` and `Ts` combinations;
   - invisible text;
   - inline images.
3. **Chromium fixtures.** Generated with Playwright `page.pdf()`, which the framework already uses, from HTML with known text and positions. The test asserts that the text and positions recovered match the rendered DOM within tolerance.
4. **Real report fixtures.** Anonymised SSRS and Crystal PDFs supplied by the user, each with a reviewed golden JSON and `analyzeReport` snapshot. This is the most important suite for G1 and G3.
5. **Reference corpus (`test/pdf/corpus/`, the "any PDF" gate).** This holds 985 real PDFs selected by stratified sampling from the 7.9 M-file SafeDocs corpus. It covers more than 40 producer families, every PDF version from 1.1 to 2.0, RC4, AES-128 and AES-256 encryption, all filters, every font type including Type 3, 25 languages including CJK, RTL and Indic scripts, and 42 broken or non-PDF files. `manifest.csv` is committed; the files are fetched with `scripts/pdf-engine/fetch-sample-corpus.js` and git-ignored. Each run asserts the G0/G4 invariants and records per-file text, warnings and timings. Differences from the last reviewed baseline are flagged for review, so every engine change is measured against the whole corpus.
6. **Mutation fuzzer.** Our own, roughly 200 lines. It flips, truncates and splices fixture bytes and asserts the G4 invariants, and runs in CI on a time budget.
7. **Optional oracle (development only).** If a developer has pdfjs-dist installed locally, `REPORT_PDF_ENGINE=dual` reports text and position differences on real reports. This compares outputs only; no code is reused, and it isn't required.
8. **Benchmarks.** `test/pdf/bench.ts` reports pages per second and peak memory on the fixture set and tracks them over time.

---

## 10. Milestones

Effort figures are for one engineer, and they assume real report samples become available by M3.

| Milestone | Scope | Exit criteria | Est. |
|---|---|---|---|
| **M0 Foundations** | Module skeleton, error/warning types, options and limits, `node:test` setup, `CSTestPdfWriter` v1, reference-data generation script | `npm run build` and `npm run test:pdf` green; data tables generated with notices | 1 wk |
| **M1 Objects** | L0 + L1 without encryption: lexer, parser, filters, xref tables and streams, incremental updates, object streams, recovery | Every structural fixture parses; recovery fixtures parse with the expected warnings; fuzzer shows no crashes | 3 wk |
| **M2 Document** | L2: page tree, boxes, rotation, Info, XMP, dates, text strings, outline, page labels, annotations | Metadata, outline and annotation fixtures match their golden JSON | 1.5 wk |
| **M3 Text** | L3 + L4: simple and Type0 fonts, CMaps, encodings, glyph names, Core-14 widths, TrueType cmap/post reader, interpreter, glyph emission, Form XObjects | Glyph positions within ±0.01 pt on synthetic fixtures; 100 % text on Chromium fixtures; first real SSRS/Crystal samples decoded | 4–5 wk |
| **M4 Security + layout** | Standard handler R2–R6, our own RC4; spans, words, lines, rulings, normalisation, colour | Encrypted fixtures decode; layout fixtures match golden JSON; rulings found on table fixtures | 2.5 wk |
| **M5b Universal text** | CJK predefined CMaps and the CID collections (generated, loaded lazily), vertical writing, our own UAX #9 bidi, Type 3 and embedded Type 1 / CFF glyph-name recovery, `ActualText` | Corpus language buckets pass their review; G0 is met across the corpus | 3 wk |
| **M5 Integration** | Planned and estimated in `VERIFICATION-DESIGN.md` as R1 (golden capture) and R2 (provider + swap), so it isn't counted twice here | — | — |
| **M6 Product polish** | CLI, JSON Schema file, USER-GUIDE, examples, benchmarks, error-message review, `THIRD-PARTY-NOTICES.md` | Docs complete; G5 benchmark met | 1.5 wk |
| | | **Total (engine only)** | **≈ 16–17 weeks** |

Each milestone ends with a review checkpoint, and nothing is committed or pushed without the owner's go-ahead.

---

## 11. Open questions and decisions needed

1. **Your own sample reports.** The public corpus now has 228 SSRS and Crystal PDFs covering every renderer version. Your own reports would still be the best G1/G3 gate. Can we get a handful of anonymised SSRS and Crystal PDFs? They decide how much embedded-font fallback work M3 needs, because Microsoft states SSRS can emit glyph-ID text. They also become the G1 and G3 golden suite.
2. **Pixel-based checks.** Barcode, visual regression, image inventory and OCR need page rendering. Options:
   - (a) keep those four checks on an optional renderer;
   - (b) render through the framework's existing Playwright Chromium, which opens the PDF in its built-in viewer and takes a screenshot, so no new dependency is added;
   - (c) build our own rasteriser later (large effort).

   **Recommendation: (b).**
3. **Coordinate default.** Keep bottom-left (PDF native, as today) as the default, with `coordinates: 'top-left'` opt-in? **Recommendation: yes.**
4. **Subpath name.** `…/pdf` as proposed, or something else?
5. **Separate package later.** The engine has no imports from the rest of the framework, so it can be published separately if you want that later.

---

## 12. Clean-room and licensing policy

- Implementation references: ISO 32000-1/-2, the OpenType specification (`cmap`, `post`, `head`, `hhea`, `hmtx`, `OS/2`), the Adobe CFF specification (Technical Note #5176), the Adobe Glyph List Specification, and the Node.js API docs.
- Contributors don't open other PDF libraries' source code while implementing a module. The research report describes *what* the problems are; it isn't a code source.
- Reference data:
  - The Adobe Glyph List (BSD-3-Clause), the Core-14 AFM metrics (Adobe's redistribution terms) and, for M5b, Adobe's published CMap resources and CID→Unicode tables (BSD-3-Clause) are kept unmodified in `scripts/pdf-engine/raw/`, together with their notices. Unicode's `BidiCharacterTest` / `BidiTest` data files (Unicode license) are used only as test vectors.
  - Our script turns them into `src/pdf/data/*.data.ts`.
  - `THIRD-PARTY-NOTICES.md` lists both, and it ships in the npm package.
- Everything else is original code under the framework's MIT license.
