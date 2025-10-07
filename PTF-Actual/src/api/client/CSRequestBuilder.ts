import { OutgoingHttpHeaders } from 'http';
import { CSRequestOptions, CSHttpMethod, CSAuthConfig, CSProxyConfig, CSMultipartField } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSRequestBuilder {
    private request: CSRequestOptions;

    constructor(url?: string) {
        this.request = {
            url: url || '',
            method: 'GET',
            headers: {}
        };
    }

    public setUrl(url: string): CSRequestBuilder {
        this.request.url = url;
        return this;
    }

    public setMethod(method: CSHttpMethod): CSRequestBuilder {
        this.request.method = method;
        return this;
    }

    public get(url?: string): CSRequestBuilder {
        if (url) this.request.url = url;
        this.request.method = 'GET';
        return this;
    }

    public post(url?: string): CSRequestBuilder {
        if (url) this.request.url = url;
        this.request.method = 'POST';
        return this;
    }

    public put(url?: string): CSRequestBuilder {
        if (url) this.request.url = url;
        this.request.method = 'PUT';
        return this;
    }

    public patch(url?: string): CSRequestBuilder {
        if (url) this.request.url = url;
        this.request.method = 'PATCH';
        return this;
    }

    public delete(url?: string): CSRequestBuilder {
        if (url) this.request.url = url;
        this.request.method = 'DELETE';
        return this;
    }

    public head(url?: string): CSRequestBuilder {
        if (url) this.request.url = url;
        this.request.method = 'HEAD';
        return this;
    }

    public options(url?: string): CSRequestBuilder {
        if (url) this.request.url = url;
        this.request.method = 'OPTIONS';
        return this;
    }

    public setHeader(name: string, value: string | number): CSRequestBuilder {
        if (!this.request.headers) this.request.headers = {};
        this.request.headers[name] = String(value);
        return this;
    }

    public setHeaders(headers: OutgoingHttpHeaders): CSRequestBuilder {
        this.request.headers = { ...this.request.headers, ...headers };
        return this;
    }

    public setContentType(contentType: string): CSRequestBuilder {
        return this.setHeader('Content-Type', contentType);
    }

    public setAccept(accept: string): CSRequestBuilder {
        return this.setHeader('Accept', accept);
    }

    public setUserAgent(userAgent: string): CSRequestBuilder {
        return this.setHeader('User-Agent', userAgent);
    }

    public setAuthorization(authorization: string): CSRequestBuilder {
        return this.setHeader('Authorization', authorization);
    }

    public setCookie(cookie: string): CSRequestBuilder {
        return this.setHeader('Cookie', cookie);
    }

    public setBody(body: any): CSRequestBuilder {
        this.request.body = body;
        return this;
    }

    public setJsonBody(json: any): CSRequestBuilder {
        this.request.body = json;
        this.setContentType('application/json');
        return this;
    }

    public setFormBody(form: Record<string, any>): CSRequestBuilder {
        this.request.body = form;
        this.setContentType('application/x-www-form-urlencoded');
        return this;
    }

    public setMultipartBody(fields: CSMultipartField[]): CSRequestBuilder {
        this.request.body = fields;
        this.setContentType('multipart/form-data');
        return this;
    }

    public setTextBody(text: string): CSRequestBuilder {
        this.request.body = text;
        this.setContentType('text/plain');
        return this;
    }

    public setXmlBody(xml: string): CSRequestBuilder {
        this.request.body = xml;
        this.setContentType('application/xml');
        return this;
    }

    public setQuery(params: Record<string, any>): CSRequestBuilder {
        this.request.query = params;
        return this;
    }

    public addQueryParam(key: string, value: any): CSRequestBuilder {
        if (!this.request.query) this.request.query = {};
        this.request.query[key] = value;
        return this;
    }

    public setPathParams(params: Record<string, any>): CSRequestBuilder {
        this.request.params = params;
        return this;
    }

    public addPathParam(key: string, value: any): CSRequestBuilder {
        if (!this.request.params) this.request.params = {};
        this.request.params[key] = value;
        return this;
    }

    public setAuth(auth: CSAuthConfig): CSRequestBuilder {
        this.request.auth = auth;
        return this;
    }

    public setBasicAuth(username: string, password: string): CSRequestBuilder {
        this.request.auth = {
            type: 'basic',
            credentials: { username, password }
        };
        return this;
    }

    public setBearerToken(token: string): CSRequestBuilder {
        this.request.auth = {
            type: 'bearer',
            credentials: { token }
        };
        return this;
    }

    public setApiKey(apiKey: string, headerName?: string): CSRequestBuilder {
        this.request.auth = {
            type: 'apikey',
            credentials: { apiKey },
            options: { headerName: headerName || 'X-API-Key' }
        };
        return this;
    }

    public setTimeout(timeout: number): CSRequestBuilder {
        this.request.timeout = timeout;
        return this;
    }

    public setRetries(retries: number): CSRequestBuilder {
        this.request.retries = retries;
        return this;
    }

    public setRetryDelay(delay: number): CSRequestBuilder {
        this.request.retryDelay = delay;
        return this;
    }

    public setProxy(proxy: CSProxyConfig): CSRequestBuilder {
        this.request.proxy = proxy;
        return this;
    }

    public followRedirects(follow: boolean = true): CSRequestBuilder {
        this.request.followRedirects = follow;
        return this;
    }

    public setMaxRedirects(max: number): CSRequestBuilder {
        this.request.maxRedirects = max;
        return this;
    }

    public compress(enable: boolean = true): CSRequestBuilder {
        this.request.compress = enable;
        return this;
    }

    public setResponseType(type: 'json' | 'text' | 'buffer' | 'stream' | 'arraybuffer' | 'blob'): CSRequestBuilder {
        this.request.responseType = type;
        return this;
    }

    public setKeepAlive(keepAlive: boolean): CSRequestBuilder {
        this.request.keepAlive = keepAlive;
        return this;
    }

    public setRejectUnauthorized(reject: boolean): CSRequestBuilder {
        this.request.rejectUnauthorized = reject;
        return this;
    }

    public setCertificate(cert: string | Buffer, key?: string | Buffer, ca?: string | Buffer): CSRequestBuilder {
        this.request.cert = cert;
        if (key) this.request.key = key;
        if (ca) this.request.ca = ca;
        return this;
    }

    public setPfx(pfx: string | Buffer, passphrase?: string): CSRequestBuilder {
        this.request.pfx = pfx;
        if (passphrase) this.request.passphrase = passphrase;
        return this;
    }

    public setMetadata(metadata: Record<string, any>): CSRequestBuilder {
        this.request.metadata = metadata;
        return this;
    }

    public addMetadata(key: string, value: any): CSRequestBuilder {
        if (!this.request.metadata) this.request.metadata = {};
        this.request.metadata[key] = value;
        return this;
    }

    public onUploadProgress(callback: (progress: any) => void): CSRequestBuilder {
        this.request.onUploadProgress = callback;
        return this;
    }

    public onDownloadProgress(callback: (progress: any) => void): CSRequestBuilder {
        this.request.onDownloadProgress = callback;
        return this;
    }

    public validateStatus(validator: (status: number) => boolean): CSRequestBuilder {
        this.request.validateStatus = validator;
        return this;
    }

    public build(): CSRequestOptions {
        if (!this.request.url) {
            throw new Error('URL is required');
        }

        CSReporter.debug(`Request built: ${this.request.method} ${this.request.url}`);
        return { ...this.request };
    }

    public clone(): CSRequestBuilder {
        const builder = new CSRequestBuilder();
        builder.request = JSON.parse(JSON.stringify(this.request));
        return builder;
    }

    public static create(url?: string): CSRequestBuilder {
        return new CSRequestBuilder(url);
    }

    public static fromOptions(options: CSRequestOptions): CSRequestBuilder {
        const builder = new CSRequestBuilder();
        builder.request = { ...options };
        return builder;
    }

    public toString(): string {
        return `${this.request.method} ${this.request.url}`;
    }

    public toJSON(): CSRequestOptions {
        return this.build();
    }

    public reset(): CSRequestBuilder {
        this.request = {
            url: '',
            method: 'GET',
            headers: {}
        };
        return this;
    }

    public inspect(): CSRequestOptions {
        return { ...this.request };
    }
}