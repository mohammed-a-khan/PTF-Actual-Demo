import { CSResponse, CSValidationResult, CSValidationError } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';
import { OutgoingHttpHeaders } from 'http';

export interface CSHeaderValidationConfig {
    name?: string;
    value?: string | RegExp;
    exists?: boolean;
    notExists?: boolean;
    contains?: string;
    pattern?: string | RegExp;
    caseInsensitive?: boolean;
    multiple?: CSHeaderValidationConfig[];
    cors?: CSCorsValidationConfig;
    security?: CSSecurityHeadersConfig;
    caching?: CSCachingHeadersConfig;
    custom?: (headers: OutgoingHttpHeaders) => boolean | string;
}

export interface CSCorsValidationConfig {
    allowOrigin?: string | string[] | RegExp;
    allowMethods?: string[];
    allowHeaders?: string[];
    allowCredentials?: boolean;
    maxAge?: number;
    exposeHeaders?: string[];
}

export interface CSSecurityHeadersConfig {
    contentSecurityPolicy?: boolean | string;
    strictTransportSecurity?: boolean | { maxAge: number; includeSubDomains?: boolean; preload?: boolean };
    xContentTypeOptions?: boolean;
    xFrameOptions?: 'DENY' | 'SAMEORIGIN' | string;
    xXssProtection?: boolean | string;
    referrerPolicy?: string;
    permissionsPolicy?: string;
    crossOriginEmbedderPolicy?: string;
    crossOriginOpenerPolicy?: string;
    crossOriginResourcePolicy?: string;
}

export interface CSCachingHeadersConfig {
    cacheControl?: string | { maxAge?: number; mustRevalidate?: boolean; noCache?: boolean; noStore?: boolean; private?: boolean; public?: boolean };
    etag?: boolean | string;
    lastModified?: boolean | Date;
    expires?: boolean | Date;
    pragma?: string;
    vary?: string | string[];
}

export class CSHeaderValidator {
    private readonly securityHeaders = [
        'Content-Security-Policy',
        'Strict-Transport-Security',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'X-XSS-Protection',
        'Referrer-Policy',
        'Permissions-Policy',
        'Cross-Origin-Embedder-Policy',
        'Cross-Origin-Opener-Policy',
        'Cross-Origin-Resource-Policy'
    ];

    private readonly cachingHeaders = [
        'Cache-Control',
        'ETag',
        'Last-Modified',
        'Expires',
        'Pragma',
        'Vary'
    ];

    public validate(response: CSResponse, config: CSHeaderValidationConfig): CSValidationResult {
        const errors: CSValidationError[] = [];
        const warnings: string[] = [];
        const startTime = Date.now();

        CSReporter.debug(`Validating headers`);

        // Single header validation
        if (config.name) {
            this.validateSingleHeader(response.headers, config, errors, warnings);
        }

        // Multiple headers validation
        if (config.multiple) {
            for (const headerConfig of config.multiple) {
                this.validateSingleHeader(response.headers, headerConfig, errors, warnings);
            }
        }

        // CORS validation
        if (config.cors) {
            this.validateCorsHeaders(response.headers, config.cors, errors, warnings);
        }

        // Security headers validation
        if (config.security) {
            this.validateSecurityHeaders(response.headers, config.security, errors, warnings);
        }

        // Caching headers validation
        if (config.caching) {
            this.validateCachingHeaders(response.headers, config.caching, errors, warnings);
        }

        // Custom validation
        if (config.custom) {
            const result = config.custom(response.headers);
            if (result !== true) {
                errors.push({
                    path: 'headers',
                    expected: 'custom validation to pass',
                    actual: 'failed',
                    message: typeof result === 'string' ? result : 'Custom header validation failed',
                    type: 'header'
                });
            }
        }

        const duration = Date.now() - startTime;

        return {
            valid: errors.length === 0,
            errors,
            warnings: warnings.length > 0 ? warnings : undefined,
            duration,
            metadata: {
                headerCount: Object.keys(response.headers).length,
                contentType: this.getHeaderValue(response.headers, 'content-type'),
                contentLength: this.getHeaderValue(response.headers, 'content-length')
            }
        };
    }

    private validateSingleHeader(
        headers: OutgoingHttpHeaders,
        config: CSHeaderValidationConfig,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        if (!config.name) return;

        const headerValue = this.getHeaderValue(headers, config.name, config.caseInsensitive);

        // Exists validation
        if (config.exists === true && !headerValue) {
            errors.push({
                path: `headers.${config.name}`,
                expected: 'header to exist',
                actual: 'not found',
                message: `Expected header '${config.name}' to exist`,
                type: 'header'
            });
        }

        // Not exists validation
        if (config.notExists === true && headerValue) {
            errors.push({
                path: `headers.${config.name}`,
                expected: 'header not to exist',
                actual: headerValue,
                message: `Expected header '${config.name}' not to exist`,
                type: 'header'
            });
        }

        // Value validation
        if (config.value !== undefined && headerValue) {
            const matches = config.value instanceof RegExp
                ? config.value.test(headerValue)
                : headerValue === config.value;

            if (!matches) {
                errors.push({
                    path: `headers.${config.name}`,
                    expected: String(config.value),
                    actual: headerValue,
                    message: `Expected header '${config.name}' to be '${config.value}', but got '${headerValue}'`,
                    type: 'header'
                });
            }
        }

        // Contains validation
        if (config.contains && headerValue) {
            if (!headerValue.includes(config.contains)) {
                errors.push({
                    path: `headers.${config.name}`,
                    expected: `contain '${config.contains}'`,
                    actual: headerValue,
                    message: `Expected header '${config.name}' to contain '${config.contains}'`,
                    type: 'header'
                });
            }
        }

        // Pattern validation
        if (config.pattern && headerValue) {
            const regex = typeof config.pattern === 'string'
                ? new RegExp(config.pattern)
                : config.pattern;

            if (!regex.test(headerValue)) {
                errors.push({
                    path: `headers.${config.name}`,
                    expected: `match pattern ${regex}`,
                    actual: headerValue,
                    message: `Expected header '${config.name}' to match pattern ${regex}`,
                    type: 'header'
                });
            }
        }
    }

    private validateCorsHeaders(
        headers: OutgoingHttpHeaders,
        config: CSCorsValidationConfig,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        // Access-Control-Allow-Origin
        if (config.allowOrigin) {
            const origin = this.getHeaderValue(headers, 'access-control-allow-origin');
            if (!origin) {
                errors.push({
                    path: 'headers.access-control-allow-origin',
                    expected: 'CORS origin header',
                    actual: 'not found',
                    message: 'Missing CORS Access-Control-Allow-Origin header',
                    type: 'header'
                });
            } else {
                const valid = this.validateCorsOrigin(origin, config.allowOrigin);
                if (!valid) {
                    errors.push({
                        path: 'headers.access-control-allow-origin',
                        expected: String(config.allowOrigin),
                        actual: origin,
                        message: `Invalid CORS origin: ${origin}`,
                        type: 'header'
                    });
                }
            }
        }

        // Access-Control-Allow-Methods
        if (config.allowMethods) {
            const methods = this.getHeaderValue(headers, 'access-control-allow-methods');
            if (methods) {
                const methodList = methods.split(',').map(m => m.trim());
                for (const method of config.allowMethods) {
                    if (!methodList.includes(method)) {
                        warnings.push(`CORS method '${method}' not in Access-Control-Allow-Methods`);
                    }
                }
            }
        }

        // Access-Control-Allow-Credentials
        if (config.allowCredentials !== undefined) {
            const credentials = this.getHeaderValue(headers, 'access-control-allow-credentials');
            const expected = config.allowCredentials ? 'true' : 'false';
            if (credentials !== expected) {
                errors.push({
                    path: 'headers.access-control-allow-credentials',
                    expected,
                    actual: credentials || 'not set',
                    message: `Expected Access-Control-Allow-Credentials to be '${expected}'`,
                    type: 'header'
                });
            }
        }

        // Access-Control-Max-Age
        if (config.maxAge !== undefined) {
            const maxAge = this.getHeaderValue(headers, 'access-control-max-age');
            if (maxAge && parseInt(maxAge) !== config.maxAge) {
                warnings.push(`CORS Max-Age is ${maxAge}, expected ${config.maxAge}`);
            }
        }
    }

    private validateSecurityHeaders(
        headers: OutgoingHttpHeaders,
        config: CSSecurityHeadersConfig,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        // Content-Security-Policy
        if (config.contentSecurityPolicy) {
            const csp = this.getHeaderValue(headers, 'content-security-policy');
            if (!csp) {
                warnings.push('Missing Content-Security-Policy header');
            } else if (typeof config.contentSecurityPolicy === 'string' && csp !== config.contentSecurityPolicy) {
                errors.push({
                    path: 'headers.content-security-policy',
                    expected: config.contentSecurityPolicy,
                    actual: csp,
                    message: 'Content-Security-Policy mismatch',
                    type: 'header'
                });
            }
        }

        // Strict-Transport-Security
        if (config.strictTransportSecurity) {
            const sts = this.getHeaderValue(headers, 'strict-transport-security');
            if (!sts) {
                warnings.push('Missing Strict-Transport-Security header');
            } else if (typeof config.strictTransportSecurity === 'object') {
                const expectedSts = this.buildStsHeader(config.strictTransportSecurity);
                if (!sts.includes(`max-age=${config.strictTransportSecurity.maxAge}`)) {
                    errors.push({
                        path: 'headers.strict-transport-security',
                        expected: expectedSts,
                        actual: sts,
                        message: 'Strict-Transport-Security mismatch',
                        type: 'header'
                    });
                }
            }
        }

        // X-Content-Type-Options
        if (config.xContentTypeOptions) {
            const xcto = this.getHeaderValue(headers, 'x-content-type-options');
            if (xcto !== 'nosniff') {
                warnings.push('X-Content-Type-Options should be "nosniff"');
            }
        }

        // X-Frame-Options
        if (config.xFrameOptions) {
            const xfo = this.getHeaderValue(headers, 'x-frame-options');
            if (xfo !== config.xFrameOptions) {
                errors.push({
                    path: 'headers.x-frame-options',
                    expected: config.xFrameOptions,
                    actual: xfo || 'not set',
                    message: `X-Frame-Options should be '${config.xFrameOptions}'`,
                    type: 'header'
                });
            }
        }

        // X-XSS-Protection
        if (config.xXssProtection) {
            const xxp = this.getHeaderValue(headers, 'x-xss-protection');
            const expected = typeof config.xXssProtection === 'string' ? config.xXssProtection : '1; mode=block';
            if (xxp !== expected) {
                warnings.push(`X-XSS-Protection should be '${expected}'`);
            }
        }

        // Referrer-Policy
        if (config.referrerPolicy) {
            const rp = this.getHeaderValue(headers, 'referrer-policy');
            if (rp !== config.referrerPolicy) {
                warnings.push(`Referrer-Policy should be '${config.referrerPolicy}'`);
            }
        }
    }

    private validateCachingHeaders(
        headers: OutgoingHttpHeaders,
        config: CSCachingHeadersConfig,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        // Cache-Control
        if (config.cacheControl) {
            const cc = this.getHeaderValue(headers, 'cache-control');
            if (typeof config.cacheControl === 'string') {
                if (cc !== config.cacheControl) {
                    errors.push({
                        path: 'headers.cache-control',
                        expected: config.cacheControl,
                        actual: cc || 'not set',
                        message: 'Cache-Control mismatch',
                        type: 'header'
                    });
                }
            } else if (typeof config.cacheControl === 'object' && cc) {
                const directives = this.parseCacheControl(cc);
                this.validateCacheControlDirectives(directives, config.cacheControl, warnings);
            }
        }

        // ETag
        if (config.etag) {
            const etag = this.getHeaderValue(headers, 'etag');
            if (config.etag === true && !etag) {
                warnings.push('Missing ETag header');
            } else if (typeof config.etag === 'string' && etag !== config.etag) {
                errors.push({
                    path: 'headers.etag',
                    expected: config.etag,
                    actual: etag || 'not set',
                    message: 'ETag mismatch',
                    type: 'header'
                });
            }
        }

        // Last-Modified
        if (config.lastModified) {
            const lm = this.getHeaderValue(headers, 'last-modified');
            if (config.lastModified === true && !lm) {
                warnings.push('Missing Last-Modified header');
            } else if (config.lastModified instanceof Date && lm) {
                const actualDate = new Date(lm);
                if (actualDate.getTime() !== config.lastModified.getTime()) {
                    errors.push({
                        path: 'headers.last-modified',
                        expected: config.lastModified.toUTCString(),
                        actual: lm,
                        message: 'Last-Modified mismatch',
                        type: 'header'
                    });
                }
            }
        }

        // Vary
        if (config.vary) {
            const vary = this.getHeaderValue(headers, 'vary');
            const expectedVary = Array.isArray(config.vary) ? config.vary.join(', ') : config.vary;
            if (vary !== expectedVary) {
                warnings.push(`Vary header should be '${expectedVary}'`);
            }
        }
    }

    private validateCorsOrigin(origin: string, expected: string | string[] | RegExp): boolean {
        if (origin === '*') return true;

        if (expected instanceof RegExp) {
            return expected.test(origin);
        }

        if (Array.isArray(expected)) {
            return expected.includes(origin);
        }

        return origin === expected;
    }

    private buildStsHeader(config: { maxAge: number; includeSubDomains?: boolean; preload?: boolean }): string {
        let header = `max-age=${config.maxAge}`;
        if (config.includeSubDomains) header += '; includeSubDomains';
        if (config.preload) header += '; preload';
        return header;
    }

    private parseCacheControl(value: string): Map<string, string> {
        const directives = new Map<string, string>();
        const parts = value.split(',').map(p => p.trim());

        for (const part of parts) {
            const [key, val] = part.split('=').map(p => p.trim());
            directives.set(key.toLowerCase(), val || 'true');
        }

        return directives;
    }

    private validateCacheControlDirectives(
        actual: Map<string, string>,
        expected: any,
        warnings: string[]
    ): void {
        if (expected.maxAge !== undefined && actual.get('max-age') !== String(expected.maxAge)) {
            warnings.push(`Cache-Control max-age should be ${expected.maxAge}`);
        }
        if (expected.mustRevalidate && !actual.has('must-revalidate')) {
            warnings.push('Cache-Control should include must-revalidate');
        }
        if (expected.noCache && !actual.has('no-cache')) {
            warnings.push('Cache-Control should include no-cache');
        }
        if (expected.noStore && !actual.has('no-store')) {
            warnings.push('Cache-Control should include no-store');
        }
        if (expected.private && !actual.has('private')) {
            warnings.push('Cache-Control should include private');
        }
        if (expected.public && !actual.has('public')) {
            warnings.push('Cache-Control should include public');
        }
    }

    private getHeaderValue(headers: OutgoingHttpHeaders, name: string, caseInsensitive: boolean = true): string | undefined {
        const searchName = caseInsensitive ? name.toLowerCase() : name;

        for (const [key, value] of Object.entries(headers)) {
            const compareKey = caseInsensitive ? key.toLowerCase() : key;
            if (compareKey === searchName) {
                return Array.isArray(value) ? value.join(', ') : String(value);
            }
        }

        return undefined;
    }

    public expectHeader(name: string, value?: string): CSHeaderValidationConfig {
        return { name, value, exists: value === undefined };
    }

    public expectNoHeader(name: string): CSHeaderValidationConfig {
        return { name, notExists: true };
    }

    public expectContentType(contentType: string): CSHeaderValidationConfig {
        return { name: 'content-type', value: contentType };
    }

    public expectJson(): CSHeaderValidationConfig {
        return { name: 'content-type', contains: 'application/json' };
    }

    public expectCors(config: CSCorsValidationConfig): CSHeaderValidationConfig {
        return { cors: config };
    }

    public expectSecurity(config: CSSecurityHeadersConfig): CSHeaderValidationConfig {
        return { security: config };
    }

    public expectCaching(config: CSCachingHeadersConfig): CSHeaderValidationConfig {
        return { caching: config };
    }
}

export const headerValidator = new CSHeaderValidator();