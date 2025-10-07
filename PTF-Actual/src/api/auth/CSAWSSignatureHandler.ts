import { CSReporter } from '../../reporter/CSReporter';
import * as crypto from 'crypto';
import { URL } from 'url';
import { OutgoingHttpHeaders } from 'http';

export interface CSAWSCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region?: string;
}

export interface CSAWSSignatureConfig {
    credentials: CSAWSCredentials;
    service: string;
    region: string;
    signatureVersion?: 'v4' | 'v2';
    signHeaders?: boolean;
    signQuery?: boolean;
    doubleEncode?: boolean;
    expires?: number;
}

export interface CSAWSSignedRequest {
    method: string;
    url: string;
    headers: OutgoingHttpHeaders;
    body?: string | Buffer;
}

export class CSAWSSignatureHandler {
    private config: CSAWSSignatureConfig;
    private readonly algorithm = 'AWS4-HMAC-SHA256';
    private readonly dateFormat = 'YYYYMMDDTHHmmssZ';
    private readonly shortDateFormat = 'YYYYMMDD';

    constructor(config: CSAWSSignatureConfig) {
        this.config = {
            signatureVersion: 'v4',
            signHeaders: true,
            signQuery: false,
            doubleEncode: true,
            ...config
        };
    }

    public sign(request: CSAWSSignedRequest): CSAWSSignedRequest {
        if (this.config.signatureVersion === 'v2') {
            return this.signV2(request);
        }
        return this.signV4(request);
    }

    private signV4(request: CSAWSSignedRequest): CSAWSSignedRequest {
        const url = new URL(request.url);
        const datetime = this.getDateTime();
        const date = datetime.substring(0, 8);

        // Prepare headers
        const headers: OutgoingHttpHeaders = { ...request.headers };
        headers['Host'] = url.host;
        headers['X-Amz-Date'] = datetime;

        if (this.config.credentials.sessionToken) {
            headers['X-Amz-Security-Token'] = this.config.credentials.sessionToken;
        }

        // Calculate content hash
        const payloadHash = this.hashPayload(request.body);
        headers['X-Amz-Content-Sha256'] = payloadHash;

        // Build canonical request
        const canonicalRequest = this.buildCanonicalRequest(
            request.method,
            url,
            headers,
            payloadHash
        );

        // Build string to sign
        const credentialScope = `${date}/${this.config.region}/${this.config.service}/aws4_request`;
        const stringToSign = this.buildStringToSign(datetime, credentialScope, canonicalRequest);

        // Calculate signature
        const signature = this.calculateSignature(date, stringToSign);

        // Build authorization header
        const signedHeaders = this.getSignedHeadersString(headers);
        headers['Authorization'] = this.buildAuthorizationHeader(
            credentialScope,
            signedHeaders,
            signature
        );

        CSReporter.debug(`AWS Signature V4 generated for ${request.method} ${url.pathname}`);

        return {
            ...request,
            headers
        };
    }

    private signV2(request: CSAWSSignedRequest): CSAWSSignedRequest {
        const url = new URL(request.url);
        const headers: OutgoingHttpHeaders = { ...request.headers };

        // Build string to sign
        const stringToSign = [
            request.method,
            url.hostname,
            url.pathname || '/',
            this.buildCanonicalQueryStringV2(url.searchParams)
        ].join('\n');

        // Calculate signature
        const signature = this.hmac(
            this.config.credentials.secretAccessKey,
            stringToSign,
            'base64'
        );

        // Add authorization header
        headers['Authorization'] = `AWS ${this.config.credentials.accessKeyId}:${signature}`;

        if (this.config.credentials.sessionToken) {
            headers['X-Amz-Security-Token'] = this.config.credentials.sessionToken;
        }

        CSReporter.debug(`AWS Signature V2 generated for ${request.method} ${url.pathname}`);

        return {
            ...request,
            headers
        };
    }

    private buildCanonicalRequest(
        method: string,
        url: URL,
        headers: OutgoingHttpHeaders,
        payloadHash: string
    ): string {
        const canonicalUri = this.encodeUri(url.pathname || '/');
        const canonicalQuery = this.buildCanonicalQueryString(url.searchParams);
        const canonicalHeaders = this.buildCanonicalHeaders(headers);
        const signedHeaders = this.getSignedHeadersString(headers);

        return [
            method.toUpperCase(),
            canonicalUri,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join('\n');
    }

    private buildCanonicalQueryString(params: URLSearchParams): string {
        const sorted: string[] = [];

        // Sort parameters by key
        const sortedKeys = Array.from(params.keys()).sort();

        for (const key of sortedKeys) {
            const values = params.getAll(key);
            for (const value of values) {
                const encodedKey = this.encodeComponent(key);
                const encodedValue = this.encodeComponent(value);
                sorted.push(`${encodedKey}=${encodedValue}`);
            }
        }

        return sorted.join('&');
    }

    private buildCanonicalQueryStringV2(params: URLSearchParams): string {
        const sorted: string[] = [];
        const sortedKeys = Array.from(params.keys()).sort();

        for (const key of sortedKeys) {
            const value = params.get(key) || '';
            sorted.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }

        return sorted.join('&');
    }

    private buildCanonicalHeaders(headers: OutgoingHttpHeaders): string {
        const canonical: string[] = [];
        const sortedKeys = Object.keys(headers).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        for (const key of sortedKeys) {
            const lowerKey = key.toLowerCase();
            const value = headers[key];

            if (value !== undefined) {
                const normalizedValue = Array.isArray(value)
                    ? value.map(v => this.normalizeHeaderValue(v)).join(',')
                    : this.normalizeHeaderValue(String(value));

                canonical.push(`${lowerKey}:${normalizedValue}`);
            }
        }

        return canonical.join('\n') + '\n';
    }

    private normalizeHeaderValue(value: string): string {
        // Remove excess spaces and trim
        return value.replace(/\s+/g, ' ').trim();
    }

    private getSignedHeadersString(headers: OutgoingHttpHeaders): string {
        return Object.keys(headers)
            .map(k => k.toLowerCase())
            .sort()
            .join(';');
    }

    private buildStringToSign(datetime: string, scope: string, canonicalRequest: string): string {
        const hashedRequest = this.hash(canonicalRequest);

        return [
            this.algorithm,
            datetime,
            scope,
            hashedRequest
        ].join('\n');
    }

    private calculateSignature(date: string, stringToSign: string): string {
        const kDate = this.hmac(`AWS4${this.config.credentials.secretAccessKey}`, date);
        const kRegion = this.hmac(kDate, this.config.region);
        const kService = this.hmac(kRegion, this.config.service);
        const kSigning = this.hmac(kService, 'aws4_request');

        return this.hmac(kSigning, stringToSign, 'hex');
    }

    private buildAuthorizationHeader(scope: string, signedHeaders: string, signature: string): string {
        return `${this.algorithm} Credential=${this.config.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    }

    private hashPayload(payload?: string | Buffer): string {
        if (!payload) {
            return this.hash('');
        }

        if (typeof payload === 'string') {
            return this.hash(payload);
        }

        return this.hash(payload);
    }

    private hash(data: string | Buffer): string {
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    private hmac(key: string | Buffer, data: string, encoding: 'hex' | 'base64' = 'hex'): any {
        return crypto.createHmac('sha256', key).update(data).digest(encoding);
    }

    private encodeUri(uri: string): string {
        return uri.split('/').map(segment => this.encodeComponent(segment)).join('/');
    }

    private encodeComponent(component: string): string {
        if (!this.config.doubleEncode) {
            return encodeURIComponent(component);
        }

        // AWS requires specific encoding
        return encodeURIComponent(component).replace(/[!'()*]/g, (c) => {
            return '%' + c.charCodeAt(0).toString(16).toUpperCase();
        });
    }

    private getDateTime(): string {
        const now = new Date();
        return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    }

    public presignUrl(request: CSAWSSignedRequest, expires: number = 3600): string {
        const url = new URL(request.url);
        const datetime = this.getDateTime();
        const date = datetime.substring(0, 8);

        // Add required query parameters
        url.searchParams.set('X-Amz-Algorithm', this.algorithm);
        url.searchParams.set('X-Amz-Credential', `${this.config.credentials.accessKeyId}/${date}/${this.config.region}/${this.config.service}/aws4_request`);
        url.searchParams.set('X-Amz-Date', datetime);
        url.searchParams.set('X-Amz-Expires', String(expires));

        if (this.config.credentials.sessionToken) {
            url.searchParams.set('X-Amz-Security-Token', this.config.credentials.sessionToken);
        }

        // Build canonical request for presigned URL
        const headers: OutgoingHttpHeaders = { host: url.host };
        const signedHeaders = 'host';
        url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

        const canonicalRequest = this.buildCanonicalRequestForPresigning(
            request.method,
            url,
            headers,
            'UNSIGNED-PAYLOAD'
        );

        // Build string to sign
        const credentialScope = `${date}/${this.config.region}/${this.config.service}/aws4_request`;
        const stringToSign = this.buildStringToSign(datetime, credentialScope, canonicalRequest);

        // Calculate signature
        const signature = this.calculateSignature(date, stringToSign);
        url.searchParams.set('X-Amz-Signature', signature);

        CSReporter.debug(`AWS presigned URL generated with ${expires}s expiry`);

        return url.toString();
    }

    private buildCanonicalRequestForPresigning(
        method: string,
        url: URL,
        headers: OutgoingHttpHeaders,
        payloadHash: string
    ): string {
        const canonicalUri = this.encodeUri(url.pathname || '/');
        const canonicalQuery = this.buildCanonicalQueryString(url.searchParams);
        const canonicalHeaders = this.buildCanonicalHeaders(headers);
        const signedHeaders = 'host';

        return [
            method.toUpperCase(),
            canonicalUri,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join('\n');
    }

    public async assumeRole(roleArn: string, sessionName: string, duration?: number): Promise<CSAWSCredentials> {
        // This would typically call AWS STS AssumeRole API
        // For now, this is a placeholder implementation
        CSReporter.warn('AssumeRole requires AWS SDK implementation');

        return {
            accessKeyId: 'temporary-access-key',
            secretAccessKey: 'temporary-secret-key',
            sessionToken: 'temporary-session-token',
            region: this.config.region
        };
    }

    public updateCredentials(credentials: Partial<CSAWSCredentials>): void {
        this.config.credentials = { ...this.config.credentials, ...credentials };
        CSReporter.debug('AWS credentials updated');
    }

    public getConfig(): CSAWSSignatureConfig {
        return { ...this.config };
    }
}

export class CSAWSSignatureManager {
    private static instance: CSAWSSignatureManager;
    private handlers: Map<string, CSAWSSignatureHandler>;
    private defaultRegion: string = 'us-east-1';

    private constructor() {
        this.handlers = new Map();
    }

    public static getInstance(): CSAWSSignatureManager {
        if (!CSAWSSignatureManager.instance) {
            CSAWSSignatureManager.instance = new CSAWSSignatureManager();
        }
        return CSAWSSignatureManager.instance;
    }

    public createHandler(name: string, config: CSAWSSignatureConfig): CSAWSSignatureHandler {
        const handler = new CSAWSSignatureHandler(config);
        this.handlers.set(name, handler);
        CSReporter.info(`AWS Signature handler registered: ${name}`);
        return handler;
    }

    public getHandler(name: string): CSAWSSignatureHandler | undefined {
        return this.handlers.get(name);
    }

    public removeHandler(name: string): boolean {
        return this.handlers.delete(name);
    }

    public setDefaultRegion(region: string): void {
        this.defaultRegion = region;
    }

    public getDefaultRegion(): string {
        return this.defaultRegion;
    }

    public clearAll(): void {
        this.handlers.clear();
    }
}

export const awsSignatureManager = CSAWSSignatureManager.getInstance();