import { IncomingHttpHeaders, OutgoingHttpHeaders } from 'http';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { URL } from 'url';

export interface CSRequestOptions {
    url: string;
    method?: CSHttpMethod;
    headers?: OutgoingHttpHeaders;
    body?: any;
    query?: Record<string, any>;
    params?: Record<string, any>;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
    retryStrategy?: CSRetryStrategy;
    retryConfig?: CSRetryConfig;
    auth?: CSAuthConfig;
    proxy?: CSProxyConfig;
    followRedirects?: boolean;
    maxRedirects?: number;
    compress?: boolean;
    validateStatus?: (status: number) => boolean;
    responseType?: CSResponseType;
    encoding?: BufferEncoding;
    agent?: HttpAgent | HttpsAgent;
    rejectUnauthorized?: boolean;
    cert?: string | Buffer;
    key?: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
    pfx?: string | Buffer;
    passphrase?: string;
    keepAlive?: boolean;
    socketTimeout?: number;
    connectionPool?: CSConnectionPoolConfig;
    beforeRequest?: CSRequestInterceptor;
    afterResponse?: CSResponseInterceptor;
    onUploadProgress?: (progress: CSProgressEvent) => void;
    onDownloadProgress?: (progress: CSProgressEvent) => void;
    cancelToken?: CSCancelToken;
    metadata?: Record<string, any>;
    validations?: CSValidationConfig[];
}

export type CSHttpMethod =
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'DELETE'
    | 'PATCH'
    | 'HEAD'
    | 'OPTIONS'
    | 'TRACE'
    | 'CONNECT';

export type CSResponseType =
    | 'json'
    | 'text'
    | 'buffer'
    | 'stream'
    | 'arraybuffer'
    | 'blob';

export type CSRetryStrategy =
    | 'exponential'
    | 'linear'
    | 'fibonacci'
    | 'constant'
    | 'custom';

export interface CSResponse<T = any> {
    status: number;
    statusText: string;
    headers: IncomingHttpHeaders;
    body: T;
    data?: T;
    request: CSRequestInfo;
    duration: number;
    retries: number;
    redirects: string[];
    cookies?: CSCookie[];
    size?: number;
}

export interface CSRequestInfo {
    url: string;
    method: CSHttpMethod;
    headers: OutgoingHttpHeaders;
    body?: any;
    startTime: number;
    endTime?: number;
}

export interface CSAuthConfig {
    type: CSAuthType;
    credentials?: CSAuthCredentials;
    options?: CSAuthOptions;
}

export type CSAuthType =
    | 'basic'
    | 'bearer'
    | 'apikey'
    | 'oauth2'
    | 'aws'
    | 'ntlm'
    | 'digest'
    | 'hawk'
    | 'jwt'
    | 'certificate'
    | 'custom';

export interface CSAuthCredentials {
    username?: string;
    password?: string;
    token?: string;
    apiKey?: string;
    apiSecret?: string;
    accessKey?: string;
    secretKey?: string;
    sessionToken?: string;
    domain?: string;
    workstation?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    privateKey?: string | Buffer;
    certificate?: string | Buffer;
    passphrase?: string;
    hawkId?: string;
    hawkKey?: string;
    customAuth?: (request: CSRequestOptions) => Promise<CSRequestOptions>;
}

export interface CSAuthOptions {
    headerName?: string;
    parameterName?: string;
    scheme?: string;
    realm?: string;
    algorithm?: string;
    qop?: string;
    nc?: string;
    cnonce?: string;
    opaque?: string;
    nonce?: string;
    issuer?: string;
    subject?: string;
    expiration?: number;
    grantType?: CSOAuth2GrantType;
    tokenUrl?: string;
    authorizationUrl?: string;
    redirectUri?: string;
    scope?: string | string[];
    state?: string;
    codeVerifier?: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'plain' | 'S256';
    audience?: string;
    resource?: string;
    responseType?: string;
    responseMode?: string;
    prompt?: string;
    loginHint?: string;
    region?: string;
    service?: string;
    signatureVersion?: 'v2' | 'v4';
    hawkId?: string;
    hawkKey?: string;
    hawkAlgorithm?: string;
    hawkExt?: string;
    jwtAlgorithm?: string;
    jwtIssuer?: string;
    jwtAudience?: string | string[];
    jwtSubject?: string;
    jwtExpiration?: number;
    certificateType?: 'pem' | 'der' | 'pfx' | 'p12';
    certificatePassword?: string;
    trustStore?: string | Buffer;
    validateCertificate?: boolean;
}

export type CSOAuth2GrantType =
    | 'authorization_code'
    | 'client_credentials'
    | 'password'
    | 'refresh_token'
    | 'implicit'
    | 'device_code'
    | 'urn:ietf:params:oauth:grant-type:jwt-bearer'
    | 'urn:ietf:params:oauth:grant-type:saml2-bearer'
    | 'urn:ietf:params:oauth:grant-type:token-exchange';

export interface CSProxyConfig {
    host: string;
    port: number;
    protocol?: 'http' | 'https' | 'socks' | 'socks4' | 'socks5';
    auth?: {
        username: string;
        password: string;
    };
    headers?: OutgoingHttpHeaders;
}

export interface CSValidationConfig {
    type: CSValidationType;
    config: any;
}

export type CSValidationType =
    | 'status'
    | 'header'
    | 'body'
    | 'schema'
    | 'jsonpath'
    | 'xpath'
    | 'xml'
    | 'regex'
    | 'custom';

export interface CSValidationResult {
    valid: boolean;
    errors?: CSValidationError[];
    warnings?: string[];
    duration?: number;
    metadata?: Record<string, any>;
    message?: string;
    extractedValue?: any;
}

export interface CSValidationError {
    path: string;
    expected: any;
    actual: any;
    message: string;
    type: CSValidationType | string;
    metadata?: Record<string, any>;
}

export interface CSRequestInterceptor {
    (request: CSRequestOptions): Promise<CSRequestOptions> | CSRequestOptions;
}

export interface CSResponseInterceptor {
    (response: CSResponse): Promise<CSResponse> | CSResponse;
}

export interface CSProgressEvent {
    loaded: number;
    total?: number;
    percent?: number;
    rate?: number;
    estimated?: number;
}

export interface CSCancelToken {
    promise: Promise<CSCancelReason>;
    reason?: CSCancelReason;
    throwIfRequested(): void;
}

export interface CSCancelReason {
    message: string;
    code?: string;
}

export interface CSCookie {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: Date;
    maxAge?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface CSTemplateContext {
    [key: string]: any;
    request?: CSRequestOptions;
    response?: CSResponse;
    variables?: Record<string, any>;
    environment?: Record<string, any>;
    iteration?: number;
    timestamp?: number;
}

export interface CSTemplateOptions {
    useCache?: boolean;
    cacheTTL?: number;
    throwOnError?: boolean;
    keepUnresolved?: boolean;
    defaultValue?: string;
    ignoreIncludeErrors?: boolean;
    trimWhitespace?: boolean;
    format?: 'json' | 'xml' | 'yaml' | 'text';
}

export interface CSPlaceholderOptions {
    useCache?: boolean;
    throwOnError?: boolean;
    keepUnresolved?: boolean;
    defaultValue?: string;
    nullValue?: string;
    undefinedValue?: string;
    stringifyObjects?: boolean;
    jsonIndent?: number;
}

export interface CSCustomResolver {
    (context: CSTemplateContext, args: string[]): any;
}

export interface CSTemplateFunction {
    (args: any[], context: CSTemplateContext): Promise<any> | any;
}

export interface CSCacheEntry {
    key: string;
    value: string;
    size: number;
    ttl: number;
    created: number;
    lastAccessed: number;
    hitCount: number;
}

export interface CSCacheOptions {
    maxSize?: number;
    maxMemory?: number;
    defaultTTL?: number;
    cleanupInterval?: number;
}

export interface CSCacheStats {
    hits: number;
    misses: number;
    sets: number;
    deletes: number;
    evictions: number;
    memoryUsage: number;
    size?: number;
    hitRate?: number;
}

export interface CSConnectionPoolConfig {
    maxSockets?: number;
    maxFreeSockets?: number;
    timeout?: number;
    keepAliveTimeout?: number;
    maxCachedSessions?: number;
    servername?: string;
}

export interface CSConnectionMetrics {
    activeConnections: number;
    idleConnections: number;
    totalRequests: number;
    totalErrors: number;
    averageResponseTime: number;
}

export interface CSRetryConfig {
    maxRetries?: number;
    retryDelay?: number;
    retryStrategy?: CSRetryStrategy;
    retryCondition?: (error: any, response?: CSResponse) => boolean;
    onRetry?: (error: any, retryCount: number) => void;
    backoffMultiplier?: number;
    maxRetryDelay?: number;
    retryOnTimeout?: boolean;
    retryOnConnectionError?: boolean;
    retryStatusCodes?: number[];
    jitter?: boolean;
}

export interface CSApiContext {
    id: string;
    name?: string;
    baseUrl?: string;
    headers?: OutgoingHttpHeaders;
    auth?: CSAuthConfig;
    proxy?: CSProxyConfig;
    timeout?: number;
    retryConfig?: CSRetryConfig;
    variables: Map<string, any>;
    responses: Map<string, CSResponse>;
    cookies: CSCookie[];
    history: CSRequestInfo[];
    metadata?: Record<string, any>;
}

export interface CSApiChain {
    id: string;
    name?: string;
    steps: CSChainStep[];
    context?: CSApiContext;
    variables?: Record<string, any>;
    onStepComplete?: (step: CSChainStep, response: CSResponse) => void;
    onError?: (error: any, step: CSChainStep) => void;
    continueOnError?: boolean;
}

export interface CSChainStep {
    id: string;
    name?: string;
    type: 'request' | 'validation' | 'extraction' | 'transformation' | 'condition' | 'loop' | 'delay';
    config: any;
    condition?: (context: CSApiContext) => boolean;
    retries?: number;
    timeout?: number;
    continueOnError?: boolean;
}

export interface CSApiMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalDuration: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    statusCodes: Record<number, number>;
    errorTypes: Record<string, number>;
}

export interface CSApiTestResult {
    passed: boolean;
    duration: number;
    requests: CSRequestInfo[];
    responses: CSResponse[];
    validations: CSValidationResult[];
    errors: any[];
    metrics: CSApiMetrics;
}

export interface CSFormData {
    append(name: string, value: string | Buffer, options?: CSFormDataOptions): void;
    getHeaders(): OutgoingHttpHeaders;
    getBoundary(): string;
    getLength(callback: (err: Error | null, length: number) => void): void;
}

export interface CSFormDataOptions {
    filename?: string;
    contentType?: string;
    knownLength?: number;
}

export interface CSMultipartField {
    name: string;
    value: string | Buffer;
    filename?: string;
    contentType?: string;
}

export interface CSRequestBuilder {
    setUrl(url: string): CSRequestBuilder;
    setMethod(method: CSHttpMethod): CSRequestBuilder;
    setHeader(name: string, value: string): CSRequestBuilder;
    setHeaders(headers: OutgoingHttpHeaders): CSRequestBuilder;
    setBody(body: any): CSRequestBuilder;
    setJsonBody(json: any): CSRequestBuilder;
    setFormBody(form: Record<string, any>): CSRequestBuilder;
    setMultipartBody(fields: CSMultipartField[]): CSRequestBuilder;
    setQuery(params: Record<string, any>): CSRequestBuilder;
    setAuth(auth: CSAuthConfig): CSRequestBuilder;
    setTimeout(timeout: number): CSRequestBuilder;
    setRetries(retries: number): CSRequestBuilder;
    setProxy(proxy: CSProxyConfig): CSRequestBuilder;
    build(): CSRequestOptions;
}

export interface CSResponseParser {
    parse(response: CSResponse, contentType?: string): Promise<any>;
    parseJson(text: string): any;
    parseXml(text: string): Promise<any>;
    parseCsv(text: string, options?: any): any[];
    parseMultipart(buffer: Buffer, boundary: string): CSMultipartField[];
    parseFormData(text: string): Record<string, any>;
}

export interface CSAuthHandler {
    authenticate(request: CSRequestOptions, auth: CSAuthConfig): Promise<CSRequestOptions>;
    refreshToken?(auth: CSAuthConfig): Promise<CSAuthConfig>;
    validateCredentials?(auth: CSAuthConfig): boolean;
}

export interface CSOAuth2Token {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
    expires_at?: number;
}

export interface CSCertificateInfo {
    subject: string;
    issuer: string;
    serialNumber: string;
    validFrom: Date;
    validTo: Date;
    fingerprint: string;
    signatureAlgorithm: string;
    publicKey: string;
    subjectAlternativeNames?: string[];
}

export interface CSSecurityPolicy {
    minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
    maxTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
    ciphers?: string[];
    rejectUnauthorized?: boolean;
    checkServerIdentity?: boolean;
    validateCertificateChain?: boolean;
    allowSelfSignedCertificates?: boolean;
    trustedCertificates?: string[];
    clientCertificate?: string | Buffer;
    clientKey?: string | Buffer;
}

export interface CSRateLimitConfig {
    maxRequests: number;
    windowMs: number;
    delayAfter?: number;
    delayMs?: number;
    skipSuccessfulRequests?: boolean;
    skipFailedRequests?: boolean;
}

export interface CSCircuitBreakerConfig {
    failureThreshold: number;
    successThreshold: number;
    timeout: number;
    resetTimeout: number;
    halfOpenRequests?: number;
}

export type CSCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CSHealthCheckConfig {
    url: string;
    method?: CSHttpMethod;
    expectedStatus?: number | number[];
    interval: number;
    timeout: number;
    retries?: number;
    onHealthy?: () => void;
    onUnhealthy?: (error: any) => void;
}

export interface CSMockConfig {
    enabled: boolean;
    responses?: CSMockResponse[];
    delay?: number;
    variability?: number;
}

export interface CSMockResponse {
    pattern: string | RegExp;
    method?: CSHttpMethod;
    status?: number;
    headers?: IncomingHttpHeaders;
    body?: any;
    delay?: number;
}

export interface CSWebSocketConfig {
    url: string;
    protocols?: string | string[];
    headers?: OutgoingHttpHeaders;
    auth?: CSAuthConfig;
    reconnect?: boolean;
    reconnectDelay?: number;
    maxReconnectAttempts?: number;
    pingInterval?: number;
    pongTimeout?: number;
}

export interface CSGraphQLConfig {
    url: string;
    headers?: OutgoingHttpHeaders;
    auth?: CSAuthConfig;
    operationName?: string;
    variables?: Record<string, any>;
    extensions?: Record<string, any>;
}

export interface CSGrpcConfig {
    host: string;
    port: number;
    credentials?: any;
    options?: Record<string, any>;
    metadata?: Record<string, any>;
}

export interface CSSoapConfig {
    wsdl: string;
    endpoint?: string;
    headers?: OutgoingHttpHeaders;
    auth?: CSAuthConfig;
    soapVersion?: '1.1' | '1.2';
    namespace?: string;
}

export interface CSApiDocumentation {
    openapi?: string;
    swagger?: string;
    raml?: string;
    apiBlueprint?: string;
    postmanCollection?: string;
}

export interface CSEnvironmentConfig {
    name: string;
    baseUrl: string;
    variables?: Record<string, any>;
    auth?: CSAuthConfig;
    headers?: OutgoingHttpHeaders;
    proxy?: CSProxyConfig;
}

export interface CSTestScenario {
    id: string;
    name: string;
    description?: string;
    environment?: string;
    setup?: CSChainStep[];
    test: CSChainStep[];
    teardown?: CSChainStep[];
    assertions?: CSValidationConfig[];
    variables?: Record<string, any>;
    tags?: string[];
}

export interface CSLoadTestConfig {
    scenario: CSTestScenario;
    duration?: number;
    users?: number;
    rampUpTime?: number;
    iterations?: number;
    thinkTime?: number;
    maxRequestsPerSecond?: number;
}

export interface CSLoadTestResult {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    percentiles: {
        p50: number;
        p90: number;
        p95: number;
        p99: number;
    };
    throughput: number;
    errorRate: number;
    duration: number;
}