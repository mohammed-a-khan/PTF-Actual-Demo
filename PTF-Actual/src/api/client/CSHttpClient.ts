import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { URL } from 'url';
import { pipeline } from 'stream';
import { promisify } from 'util';
import {
    CSRequestOptions,
    CSResponse,
    CSHttpMethod,
    CSRequestInfo,
    CSProgressEvent,
    CSCancelToken,
    CSCookie,
    CSMultipartField
} from '../types/CSApiTypes';
import { CSConnectionPool } from './CSConnectionPool';
import { CSRetryHandler } from './CSRetryHandler';
import { CSResponseParser } from './CSResponseParser';
import { CSAuthenticationHandler } from './CSAuthenticationHandler';
import { CSProxyManager } from './CSProxyManager';
import { CSReporter } from '../../reporter/CSReporter';

const pipelineAsync = promisify(pipeline);

export class CSHttpClient {
    private static instance: CSHttpClient;
    private connectionPool: CSConnectionPool;
    private retryHandler: CSRetryHandler;
    private responseParser: CSResponseParser;
    private authHandler: CSAuthenticationHandler;
    private proxyManager: CSProxyManager;
    private defaultHeaders: http.OutgoingHttpHeaders;
    private cookieJar: Map<string, CSCookie[]>;

    private constructor() {
        this.connectionPool = CSConnectionPool.getInstance();
        this.retryHandler = new CSRetryHandler();
        this.responseParser = new CSResponseParser();
        this.authHandler = new CSAuthenticationHandler();
        this.proxyManager = CSProxyManager.getInstance();
        this.cookieJar = new Map();
        this.defaultHeaders = {
            'User-Agent': 'CS-API-Client/1.0',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br'
        };
    }

    public static getInstance(): CSHttpClient {
        if (!CSHttpClient.instance) {
            CSHttpClient.instance = new CSHttpClient();
        }
        return CSHttpClient.instance;
    }

    public async request<T = any>(options: CSRequestOptions): Promise<CSResponse<T>> {
        const startTime = Date.now();
        let requestOptions = await this.prepareRequest(options);

        if (options.auth) {
            requestOptions = await this.authHandler.authenticate(requestOptions, options.auth);
        }

        if (options.beforeRequest) {
            requestOptions = await options.beforeRequest(requestOptions);
        }

        const requestInfo: CSRequestInfo = {
            url: requestOptions.url,
            method: requestOptions.method || 'GET',
            headers: requestOptions.headers || {},
            body: requestOptions.body,
            startTime
        };

        try {
            let response = await this.executeRequest(requestOptions, requestInfo);

            if (options.afterResponse) {
                response = await options.afterResponse(response);
            }

            response.duration = Date.now() - startTime;
            return response;

        } catch (error) {
            if (this.shouldRetry(error, options)) {
                return this.retryHandler.retry(() => this.request(options));
            }
            throw error;
        }
    }

    public async get<T = any>(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'GET' });
    }

    public async post<T = any>(url: string, body?: any, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'POST', body });
    }

    public async put<T = any>(url: string, body?: any, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'PUT', body });
    }

    public async patch<T = any>(url: string, body?: any, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'PATCH', body });
    }

    public async delete<T = any>(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse<T>> {
        return this.request<T>({ ...options, url, method: 'DELETE' });
    }

    public async head(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse<void>> {
        return this.request<void>({ ...options, url, method: 'HEAD' });
    }

    public async options(url: string, options?: Partial<CSRequestOptions>): Promise<CSResponse> {
        return this.request({ ...options, url, method: 'OPTIONS' });
    }

    private async prepareRequest(options: CSRequestOptions): Promise<CSRequestOptions> {
        const prepared = { ...options };

        prepared.url = this.buildUrl(options.url, options.query, options.params);

        prepared.headers = {
            ...this.defaultHeaders,
            ...options.headers
        };

        if (options.body) {
            prepared.body = await this.prepareRequestBody(options.body, prepared.headers);
        }

        const urlObj = new URL(prepared.url);
        const cookies = this.getCookiesForUrl(urlObj);
        if (cookies.length > 0) {
            prepared.headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }

        return prepared;
    }

    private buildUrl(baseUrl: string, query?: Record<string, any>, params?: Record<string, any>): string {
        let url = baseUrl;

        if (params) {
            Object.keys(params).forEach(key => {
                url = url.replace(`:${key}`, encodeURIComponent(params[key]));
            });
        }

        if (query) {
            const urlObj = new URL(url);
            Object.keys(query).forEach(key => {
                const value = query[key];
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value)) {
                        value.forEach(v => urlObj.searchParams.append(key, v));
                    } else {
                        urlObj.searchParams.append(key, String(value));
                    }
                }
            });
            url = urlObj.toString();
        }

        return url;
    }

    private async prepareRequestBody(body: any, headers: http.OutgoingHttpHeaders): Promise<Buffer | string | NodeJS.ReadableStream> {
        if (Buffer.isBuffer(body) || typeof body === 'string' || body instanceof require('stream').Readable) {
            return body;
        }


        const contentType = headers['Content-Type'];
        const contentTypeStr = Array.isArray(contentType) ? contentType[0] : contentType?.toString();

        if (contentTypeStr?.includes('application/x-www-form-urlencoded')) {
            return new URLSearchParams(body).toString();
        }

        if (contentTypeStr?.includes('multipart/form-data')) {
            return this.createMultipartBody(body, headers);
        }

        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        return JSON.stringify(body);
    }

    private createMultipartBody(fields: CSMultipartField[] | Record<string, any>, headers: http.OutgoingHttpHeaders): Buffer {
        const boundary = `----CSFormBoundary${Date.now()}${Math.random().toString(36)}`;
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;

        const parts: Buffer[] = [];

        const appendField = (name: string, value: any, filename?: string, contentType?: string) => {
            parts.push(Buffer.from(`--${boundary}\r\n`));

            if (filename) {
                parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`));
                parts.push(Buffer.from(`Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`));
            } else {
                parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
            }

            if (Buffer.isBuffer(value)) {
                parts.push(value);
            } else {
                parts.push(Buffer.from(String(value)));
            }
            parts.push(Buffer.from('\r\n'));
        };

        if (Array.isArray(fields)) {
            fields.forEach(field => {
                appendField(field.name, field.value, field.filename, field.contentType);
            });
        } else {
            Object.keys(fields).forEach(key => {
                appendField(key, fields[key]);
            });
        }

        parts.push(Buffer.from(`--${boundary}--\r\n`));
        return Buffer.concat(parts);
    }

    private async executeRequest(options: CSRequestOptions, requestInfo: CSRequestInfo): Promise<CSResponse> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(options.url);
            const isHttps = urlObj.protocol === 'https:';

            // Check for proxy configuration
            const proxyConfig = options.proxy || this.proxyManager.getProxyForUrl(options.url);

            const requestOptions: http.RequestOptions | https.RequestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: options.headers || {},
                timeout: options.timeout || 30000
            };


            // Use proxy agent if proxy is configured
            if (proxyConfig) {
                requestOptions.agent = this.proxyManager.createProxyAgent(options.url, requestOptions);
                CSReporter.debug(`Using proxy ${proxyConfig.host}:${proxyConfig.port} for ${options.url}`);
            } else if (options.agent) {
                requestOptions.agent = options.agent;
            } else {
                requestOptions.agent = isHttps
                    ? this.connectionPool.getHttpsAgent(options)
                    : this.connectionPool.getHttpAgent(options);
            }

            if (isHttps) {
                if (options.rejectUnauthorized !== undefined) {
                    (requestOptions as https.RequestOptions).rejectUnauthorized = options.rejectUnauthorized;
                }
                if (options.cert) (requestOptions as https.RequestOptions).cert = options.cert;
                if (options.key) (requestOptions as https.RequestOptions).key = options.key;
                if (options.ca) (requestOptions as https.RequestOptions).ca = options.ca;
                if (options.pfx) (requestOptions as https.RequestOptions).pfx = options.pfx;
                if (options.passphrase) (requestOptions as https.RequestOptions).passphrase = options.passphrase;
            }

            const httpModule = isHttps ? https : http;
            const req = httpModule.request(requestOptions, (res) => {
                this.handleResponse(res, options, requestInfo, resolve, reject);
            });

            req.on('error', (error: any) => {
                CSReporter.error(`Request error: ${error.message} - URL: ${options.url}`);
                reject(error);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timeout after ${options.timeout}ms`));
            });

            if (options.socketTimeout) {
                req.setTimeout(options.socketTimeout);
            }

            if (options.cancelToken) {
                options.cancelToken.promise.then(reason => {
                    req.destroy();
                    reject(new Error(reason.message));
                });
            }

            if (options.body) {
                if (options.body instanceof require('stream').Readable) {
                    options.body.pipe(req);
                    if (options.onUploadProgress) {
                        this.trackUploadProgress(options.body, options.onUploadProgress);
                    }
                } else {
                    const bodyData = typeof options.body === 'string' ? options.body : options.body;
                    req.write(bodyData);
                    req.end();
                }
            } else {
                req.end();
            }
        });
    }

    private async handleResponse(
        res: http.IncomingMessage,
        options: CSRequestOptions,
        requestInfo: CSRequestInfo,
        resolve: (value: CSResponse) => void,
        reject: (reason: any) => void
    ): Promise<void> {
        try {
            if (options.followRedirects !== false && this.isRedirect(res.statusCode)) {
                const location = res.headers.location;
                if (location) {
                    const redirectUrl = new URL(location, options.url).toString();
                    const maxRedirects = options.maxRedirects || 5;

                    if ((options as any)._redirectCount >= maxRedirects) {
                        throw new Error(`Maximum redirects (${maxRedirects}) exceeded`);
                    }

                    const redirectOptions = {
                        ...options,
                        url: redirectUrl,
                        _redirectCount: ((options as any)._redirectCount || 0) + 1
                    };

                    const response = await this.request(redirectOptions);
                    response.redirects = response.redirects || [];
                    response.redirects.unshift(options.url);
                    resolve(response);
                    return;
                }
            }

            this.storeCookiesFromResponse(res, new URL(options.url));

            const bodyBuffer = await this.readResponseBody(res, options);


            const body = await this.parseResponseBody(bodyBuffer, res.headers['content-type'], options.responseType);

            const response: CSResponse = {
                status: res.statusCode || 0,
                statusText: res.statusMessage || '',
                headers: res.headers,
                body,
                data: body,
                request: requestInfo,
                duration: Date.now() - requestInfo.startTime,
                retries: (options as any)._retryCount || 0,
                redirects: [],
                size: bodyBuffer.length
            };

            if (options.validateStatus) {
                if (!options.validateStatus(response.status)) {
                    const error = new Error(`Request failed with status ${response.status}`);
                    (error as any).response = response;
                    reject(error);
                    return;
                }
            } else if (response.status >= 400) {
                const error = new Error(`Request failed with status ${response.status}`);
                (error as any).response = response;
                reject(error);
                return;
            }

            resolve(response);
        } catch (error) {
            reject(error);
        }
    }

    private async readResponseBody(
        res: http.IncomingMessage,
        options: CSRequestOptions
    ): Promise<Buffer> {
        const encoding = res.headers['content-encoding'];
        let stream: NodeJS.ReadableStream = res;

        if (options.compress !== false) {
            if (encoding === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
                stream = res.pipe(zlib.createBrotliDecompress());
            }
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);

        return new Promise((resolve, reject) => {
            stream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                totalSize += chunk.length;

                if (options.onDownloadProgress && contentLength > 0) {
                    options.onDownloadProgress({
                        loaded: totalSize,
                        total: contentLength,
                        percent: (totalSize / contentLength) * 100
                    });
                }
            });

            stream.on('end', () => {
                resolve(Buffer.concat(chunks));
            });

            stream.on('error', reject);
        });
    }

    private async parseResponseBody(
        buffer: Buffer,
        contentType?: string,
        responseType?: string
    ): Promise<any> {
        if (responseType === 'buffer' || responseType === 'arraybuffer') {
            return buffer;
        }

        if (responseType === 'blob') {
            return buffer;
        }

        const text = buffer.toString('utf8');

        if (responseType === 'text') {
            return text;
        }

        // Check if it's JSON content type or no content type specified
        const isJsonContent = !contentType ||
                            contentType.includes('application/json') ||
                            contentType.includes('text/json') ||
                            responseType === 'json';

        if (isJsonContent) {
            try {
                return JSON.parse(text);
            } catch {
                // If parsing fails, return the text
                return text;
            }
        }

        // For other content types, use the response parser
        return this.responseParser.parse({ body: buffer } as CSResponse, contentType);
    }

    private isRedirect(statusCode?: number): boolean {
        return statusCode !== undefined && statusCode >= 300 && statusCode < 400;
    }

    private shouldRetry(error: any, options: CSRequestOptions): boolean {
        if (!options.retries || options.retries <= 0) {
            return false;
        }

        if (options.retryConfig?.retryCondition) {
            return options.retryConfig.retryCondition(error, error.response);
        }

        const isNetworkError = error.code === 'ECONNRESET' ||
                              error.code === 'ETIMEDOUT' ||
                              error.code === 'ECONNREFUSED';

        const isRetryableStatus = error.response &&
                                 options.retryConfig?.retryStatusCodes?.includes(error.response.status);

        return isNetworkError || isRetryableStatus || false;
    }

    private getCookiesForUrl(url: URL): CSCookie[] {
        const domain = url.hostname;
        const path = url.pathname;
        const cookies: CSCookie[] = [];

        this.cookieJar.forEach((domainCookies, cookieDomain) => {
            if (domain.endsWith(cookieDomain) || cookieDomain === domain) {
                domainCookies.forEach(cookie => {
                    if (!cookie.path || path.startsWith(cookie.path)) {
                        if (!cookie.expires || cookie.expires > new Date()) {
                            if (!cookie.secure || url.protocol === 'https:') {
                                cookies.push(cookie);
                            }
                        }
                    }
                });
            }
        });

        return cookies;
    }

    private storeCookiesFromResponse(res: http.IncomingMessage, url: URL): void {
        const setCookieHeaders = res.headers['set-cookie'];
        if (!setCookieHeaders) return;

        const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

        cookies.forEach(cookieStr => {
            const cookie = this.parseCookie(cookieStr);
            if (cookie) {
                const domain = cookie.domain || url.hostname;
                if (!this.cookieJar.has(domain)) {
                    this.cookieJar.set(domain, []);
                }

                const domainCookies = this.cookieJar.get(domain)!;
                const existingIndex = domainCookies.findIndex(c => c.name === cookie.name);

                if (existingIndex >= 0) {
                    domainCookies[existingIndex] = cookie;
                } else {
                    domainCookies.push(cookie);
                }
            }
        });
    }

    private parseCookie(cookieStr: string): CSCookie | null {
        const parts = cookieStr.split(';').map(s => s.trim());
        const [nameValue, ...attributes] = parts;

        if (!nameValue) return null;

        const [name, value] = nameValue.split('=');
        if (!name) return null;

        const cookie: CSCookie = { name: name.trim(), value: (value || '').trim() };

        attributes.forEach(attr => {
            const [key, val] = attr.split('=');
            const attrName = key.toLowerCase();

            switch (attrName) {
                case 'domain':
                    cookie.domain = val;
                    break;
                case 'path':
                    cookie.path = val;
                    break;
                case 'expires':
                    cookie.expires = new Date(val);
                    break;
                case 'max-age':
                    cookie.maxAge = parseInt(val, 10);
                    break;
                case 'secure':
                    cookie.secure = true;
                    break;
                case 'httponly':
                    cookie.httpOnly = true;
                    break;
                case 'samesite':
                    cookie.sameSite = val as 'Strict' | 'Lax' | 'None';
                    break;
            }
        });

        return cookie;
    }

    private trackUploadProgress(stream: NodeJS.ReadableStream, onProgress: (event: CSProgressEvent) => void): void {
        let uploaded = 0;
        const startTime = Date.now();

        stream.on('data', (chunk: Buffer) => {
            uploaded += chunk.length;
            const elapsed = Date.now() - startTime;
            const rate = uploaded / (elapsed / 1000);

            onProgress({
                loaded: uploaded,
                rate,
                estimated: elapsed
            });
        });
    }

    public setDefaultHeader(name: string, value: string): void {
        this.defaultHeaders[name] = value;
    }

    public removeDefaultHeader(name: string): void {
        delete this.defaultHeaders[name];
    }

    public clearCookies(domain?: string): void {
        if (domain) {
            this.cookieJar.delete(domain);
        } else {
            this.cookieJar.clear();
        }
    }

    public async downloadFile(
        url: string,
        destinationPath: string,
        options?: Partial<CSRequestOptions>,
        onProgress?: (progress: number) => void
    ): Promise<void> {
        const fs = await import('fs');
        const response = await this.request({
            ...options,
            url,
            method: 'GET',
            responseType: 'stream'
        } as CSRequestOptions);

        const totalSize = parseInt(response.headers['content-length'] as string) || 0;
        let downloadedSize = 0;

        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(destinationPath);
            const responseStream = response.body as any;

            if (responseStream && responseStream.on) {
                responseStream.on('data', (chunk: Buffer) => {
                    downloadedSize += chunk.length;
                    if (onProgress && totalSize > 0) {
                        onProgress((downloadedSize / totalSize) * 100);
                    }
                });

                responseStream.pipe(writeStream);
            }

            writeStream.on('finish', () => {
                CSReporter.info(`File downloaded successfully: ${destinationPath}`);
                resolve();
            });

            writeStream.on('error', reject);
            if (responseStream && responseStream.on) {
                responseStream.on('error', reject);
            }
        });
    }

    public async uploadFile(
        url: string,
        filePath: string,
        fieldName: string = 'file',
        options?: Partial<CSRequestOptions>
    ): Promise<CSResponse> {
        const fs = await import('fs');
        const path = await import('path');
        const crypto = await import('crypto');

        const boundary = `----CSFormBoundary${crypto.randomBytes(16).toString('hex')}`;
        const fileName = path.basename(filePath);

        // Read file content
        const fileContent = fs.readFileSync(filePath);

        // Create multipart form data
        const formDataParts: string[] = [];
        formDataParts.push(`--${boundary}`);
        formDataParts.push(`Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"`);
        formDataParts.push('Content-Type: application/octet-stream');
        formDataParts.push('');

        const prefix = Buffer.from(formDataParts.join('\r\n') + '\r\n');
        const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);

        // Combine all parts
        const body = Buffer.concat([prefix, fileContent, suffix]);

        // Make request with multipart content
        return await this.request({
            ...options,
            url,
            method: 'POST',
            headers: {
                ...options?.headers,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length.toString()
            },
            body
        } as CSRequestOptions);
    }

    public getCookies(domain?: string): CSCookie[] {
        if (domain) {
            return this.cookieJar.get(domain) || [];
        }

        const allCookies: CSCookie[] = [];
        this.cookieJar.forEach(cookies => allCookies.push(...cookies));
        return allCookies;
    }

    public setCookie(cookie: CSCookie, domain: string): void {
        if (!this.cookieJar.has(domain)) {
            this.cookieJar.set(domain, []);
        }
        this.cookieJar.get(domain)!.push(cookie);
    }


    public createCancelToken(): CSCancelToken {
        let cancel: (reason: any) => void;

        const promise = new Promise<any>((_, reject) => {
            cancel = reject;
        });

        return {
            promise,
            reason: undefined,
            throwIfRequested() {
                if (this.reason) {
                    throw this.reason;
                }
            }
        };
    }

    public async testConnection(url: string, timeout: number = 5000): Promise<boolean> {
        try {
            const response = await this.head(url, { timeout });
            return response.status < 500;
        } catch {
            return false;
        }
    }
}