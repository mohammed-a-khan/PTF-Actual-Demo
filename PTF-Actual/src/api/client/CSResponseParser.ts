import { CSResponse, CSMultipartField } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';
import * as xml2js from 'xml2js';

export class CSResponseParser {
    private xmlParser: xml2js.Parser;

    constructor() {
        this.xmlParser = new xml2js.Parser({
            explicitArray: false,
            mergeAttrs: true,
            normalize: true,
            normalizeTags: true,
            trim: true
        });
    }

    public async parse(response: CSResponse, contentType?: string): Promise<any> {
        if (!contentType) {
            contentType = this.detectContentType(response);
        }

        const normalizedType = contentType.toLowerCase();

        try {
            if (normalizedType.includes('application/json')) {
                return this.parseJson(response.body);
            }

            if (normalizedType.includes('application/xml') || normalizedType.includes('text/xml')) {
                return await this.parseXml(response.body);
            }

            if (normalizedType.includes('text/csv')) {
                return this.parseCsv(response.body);
            }

            if (normalizedType.includes('multipart/form-data')) {
                const boundary = this.extractBoundary(contentType);
                if (boundary) {
                    return this.parseMultipart(response.body, boundary);
                }
            }

            if (normalizedType.includes('application/x-www-form-urlencoded')) {
                return this.parseFormData(response.body);
            }

            if (normalizedType.includes('text/html')) {
                return this.parseHtml(response.body);
            }

            if (normalizedType.includes('text/plain') || normalizedType.includes('text/')) {
                return this.parseText(response.body);
            }

            // Default: try to parse as JSON first, then return as text
            try {
                return this.parseJson(response.body);
            } catch {
                // If not JSON, convert to string
                return this.convertToString(response.body);
            }

        } catch (error) {
            CSReporter.warn(`Failed to parse response as ${contentType}: ${(error as Error).message}`);
            // On error, try to return as string
            return this.convertToString(response.body);
        }
    }

    public parseJson(data: any): any {
        // Don't treat Buffer as a JSON object
        if (typeof data === 'object' && !Buffer.isBuffer(data)) {
            return data;
        }

        const text = this.convertToString(data);

        try {
            return JSON.parse(text);
        } catch (error) {
            const cleaned = this.cleanJsonString(text);
            try {
                return JSON.parse(cleaned);
            } catch {
                throw new Error(`Invalid JSON: ${(error as Error).message}`);
            }
        }
    }

    public async parseXml(data: any): Promise<any> {
        const text = this.convertToString(data);

        try {
            return await this.xmlParser.parseStringPromise(text);
        } catch (error) {
            throw new Error(`Invalid XML: ${(error as Error).message}`);
        }
    }

    public parseCsv(data: any, options?: any): any[] {
        const text = this.convertToString(data);
        const delimiter = options?.delimiter || ',';
        const hasHeader = options?.header !== false;

        const lines = text.split(/\r?\n/).filter(line => line.trim());
        if (lines.length === 0) return [];

        const headers = hasHeader ? this.parseCsvLine(lines[0], delimiter) : null;
        const startIndex = hasHeader ? 1 : 0;

        const result: any[] = [];

        for (let i = startIndex; i < lines.length; i++) {
            const values = this.parseCsvLine(lines[i], delimiter);

            if (headers) {
                const row: Record<string, any> = {};
                headers.forEach((header, index) => {
                    row[header] = values[index] || '';
                });
                result.push(row);
            } else {
                result.push(values);
            }
        }

        return result;
    }

    public parseMultipart(data: any, boundary: string): CSMultipartField[] {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(this.convertToString(data));
        const fields: CSMultipartField[] = [];

        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const endBoundaryBuffer = Buffer.from(`--${boundary}--`);

        let start = buffer.indexOf(boundaryBuffer);
        if (start === -1) return fields;

        while (start !== -1) {
            const nextBoundary = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
            const end = nextBoundary !== -1 ? nextBoundary : buffer.indexOf(endBoundaryBuffer, start);

            if (end === -1) break;

            const part = buffer.slice(start + boundaryBuffer.length, end);
            const field = this.parseMultipartField(part);
            if (field) {
                fields.push(field);
            }

            start = nextBoundary;
        }

        return fields;
    }

    public parseFormData(data: any): Record<string, any> {
        const text = this.convertToString(data);
        const params = new URLSearchParams(text);
        const result: Record<string, any> = {};

        params.forEach((value, key) => {
            if (result[key] !== undefined) {
                if (Array.isArray(result[key])) {
                    result[key].push(value);
                } else {
                    result[key] = [result[key], value];
                }
            } else {
                result[key] = value;
            }
        });

        return result;
    }

    private parseHtml(data: any): any {
        const text = this.convertToString(data);

        const title = text.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || '';
        const metaTags: Record<string, string> = {};
        const metaMatches = text.matchAll(/<meta\s+([^>]+)>/gi);

        for (const match of metaMatches) {
            const attributes = match[1];
            const nameMatch = attributes.match(/name=["']([^"']+)["']/i);
            const contentMatch = attributes.match(/content=["']([^"']+)["']/i);

            if (nameMatch && contentMatch) {
                metaTags[nameMatch[1]] = contentMatch[1];
            }
        }

        const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        const bodyText = bodyMatch ? this.stripHtmlTags(bodyMatch[1]) : '';

        return {
            title,
            metaTags,
            bodyText: bodyText.trim(),
            html: text
        };
    }

    private parseText(data: any): string {
        return this.convertToString(data);
    }

    private parseMultipartField(part: Buffer): CSMultipartField | null {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) return null;

        const headers = part.slice(0, headerEnd).toString();
        const content = part.slice(headerEnd + 4, -2);

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

        if (!nameMatch) return null;

        return {
            name: nameMatch[1],
            value: content,
            filename: filenameMatch?.[1],
            contentType: contentTypeMatch?.[1]
        };
    }

    private parseCsvLine(line: string, delimiter: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }

        result.push(current.trim());
        return result;
    }

    private detectContentType(response: CSResponse): string {
        const contentTypeHeader = response.headers['content-type'];
        if (contentTypeHeader) {
            return Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
        }

        if (Buffer.isBuffer(response.body)) {
            return this.detectContentTypeFromBuffer(response.body);
        }

        if (typeof response.body === 'string') {
            return this.detectContentTypeFromString(response.body);
        }

        if (typeof response.body === 'object') {
            return 'application/json';
        }

        return 'application/octet-stream';
    }

    private detectContentTypeFromBuffer(buffer: Buffer): string {
        if (buffer.length < 4) return 'application/octet-stream';

        const byte0 = buffer[0];
        const byte1 = buffer[1];
        const byte2 = buffer[2];
        const byte3 = buffer[3];

        if (byte0 === 0xFF && byte1 === 0xD8 && byte2 === 0xFF) {
            return 'image/jpeg';
        }

        if (byte0 === 0x89 && byte1 === 0x50 && byte2 === 0x4E && byte3 === 0x47) {
            return 'image/png';
        }

        if (byte0 === 0x47 && byte1 === 0x49 && byte2 === 0x46) {
            return 'image/gif';
        }

        if (byte0 === 0x25 && byte1 === 0x50 && byte2 === 0x44 && byte3 === 0x46) {
            return 'application/pdf';
        }

        const text = buffer.toString('utf8', 0, Math.min(buffer.length, 512));
        return this.detectContentTypeFromString(text);
    }

    private detectContentTypeFromString(text: string): string {
        const trimmed = text.trim();

        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                JSON.parse(trimmed);
                return 'application/json';
            } catch {}
        }

        if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
            return 'application/xml';
        }

        if (trimmed.toLowerCase().includes('<!doctype html') || trimmed.toLowerCase().includes('<html')) {
            return 'text/html';
        }

        if (this.looksLikeCsv(trimmed)) {
            return 'text/csv';
        }

        return 'text/plain';
    }

    private looksLikeCsv(text: string): boolean {
        const lines = text.split(/\r?\n/).slice(0, 3);
        if (lines.length < 2) return false;

        const delimiters = [',', ';', '\t', '|'];
        for (const delimiter of delimiters) {
            const counts = lines.map(line => (line.match(new RegExp(delimiter, 'g')) || []).length);
            if (counts.every(count => count > 0 && count === counts[0])) {
                return true;
            }
        }

        return false;
    }

    private extractBoundary(contentType: string): string | null {
        const match = contentType.match(/boundary=([^;]+)/i);
        if (!match) return null;

        let boundary = match[1].trim();
        if (boundary.startsWith('"') && boundary.endsWith('"')) {
            boundary = boundary.slice(1, -1);
        }

        return boundary;
    }

    private cleanJsonString(text: string): string {
        let cleaned = text.trim();

        cleaned = cleaned.replace(/^\uFEFF/, '');

        cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
        cleaned = cleaned.replace(/\/\/.*$/gm, '');

        cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

        cleaned = cleaned.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');

        cleaned = cleaned.replace(/:\s*'([^']*)'/g, ':"$1"');

        return cleaned;
    }

    private stripHtmlTags(html: string): string {
        return html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private convertToString(data: any): string {
        if (typeof data === 'string') {
            return data;
        }

        if (Buffer.isBuffer(data)) {
            return data.toString('utf8');
        }

        if (typeof data === 'object') {
            return JSON.stringify(data);
        }

        return String(data);
    }

    public async autoDetectAndParse(data: any): Promise<any> {
        const contentType = this.detectContentTypeFromData(data);
        return this.parse({ body: data } as CSResponse, contentType);
    }

    private detectContentTypeFromData(data: any): string {
        if (Buffer.isBuffer(data)) {
            return this.detectContentTypeFromBuffer(data);
        }

        if (typeof data === 'string') {
            return this.detectContentTypeFromString(data);
        }

        if (typeof data === 'object') {
            return 'application/json';
        }

        return 'text/plain';
    }
}