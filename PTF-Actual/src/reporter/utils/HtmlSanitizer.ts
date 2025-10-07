/**
 * HTML Sanitizer utility for preventing XSS attacks in reports
 */
export class HtmlSanitizer {
    /**
     * Escape HTML special characters to prevent XSS
     */
    public static escape(text: string | undefined | null): string {
        if (!text) return '';

        // Convert to string if not already
        const str = String(text);

        const htmlEscapeMap: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#x27;',
            '/': '&#x2F;',
            '`': '&#x60;',
            '=': '&#x3D;'
        };

        return str.replace(/[&<>"'`=\/]/g, char => htmlEscapeMap[char]);
    }

    /**
     * Sanitize JSON strings for safe embedding in HTML
     */
    public static escapeJson(obj: any): string {
        const jsonStr = JSON.stringify(obj);
        return this.escape(jsonStr);
    }

    /**
     * Sanitize HTML attributes
     */
    public static escapeAttribute(text: string | undefined | null): string {
        if (!text) return '';

        // For attributes, we need to be extra careful
        return this.escape(text).replace(/[\r\n]/g, '');
    }

    /**
     * Sanitize JavaScript string literals
     */
    public static escapeJsString(text: string | undefined | null): string {
        if (!text) return '';

        return String(text)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/'/g, "\\'")
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')
            .replace(/<\/script/gi, '<\\/script');
    }

    /**
     * Strip all HTML tags (for plain text display)
     */
    public static stripHtml(text: string | undefined | null): string {
        if (!text) return '';
        return String(text).replace(/<[^>]*>/g, '');
    }

    /**
     * Sanitize URL to prevent javascript: and data: protocols
     */
    public static sanitizeUrl(url: string | undefined | null): string {
        if (!url) return '#';

        const str = String(url).trim().toLowerCase();

        // Block dangerous protocols
        if (str.startsWith('javascript:') ||
            str.startsWith('data:') ||
            str.startsWith('vbscript:')) {
            return '#';
        }

        return this.escape(url);
    }
}

export const htmlEscape = HtmlSanitizer.escape;
export const jsEscape = HtmlSanitizer.escapeJsString;
export const attrEscape = HtmlSanitizer.escapeAttribute;