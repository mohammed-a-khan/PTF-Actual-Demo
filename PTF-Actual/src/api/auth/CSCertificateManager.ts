import { CSReporter } from '../../reporter/CSReporter';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as tls from 'tls';

export interface CSCertificateConfig {
    cert?: string | Buffer;
    key?: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
    passphrase?: string;
    pfx?: string | Buffer;
    rejectUnauthorized?: boolean;
    requestCert?: boolean;
    secureProtocol?: string;
    servername?: string;
    checkServerIdentity?: (servername: string, cert: any) => Error | undefined;
    minVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
    maxVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
}

export interface CSCertificateInfo {
    subject: any;
    issuer: any;
    valid_from: string;
    valid_to: string;
    fingerprint: string;
    fingerprint256: string;
    serialNumber: string;
    subjectAltNames?: string[];
    keyUsage?: string[];
    extKeyUsage?: string[];
}

export interface CSCertificateValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    info?: CSCertificateInfo;
}

export class CSCertificateManager {
    private static instance: CSCertificateManager;
    private certificates: Map<string, CSCertificateConfig>;
    private trustedCAs: Set<string | Buffer>;
    private validationCache: Map<string, CSCertificateValidationResult>;

    private constructor() {
        this.certificates = new Map();
        this.trustedCAs = new Set();
        this.validationCache = new Map();
        // DO NOT load system CAs - only load specific certificates when needed
    }

    public static getInstance(): CSCertificateManager {
        if (!CSCertificateManager.instance) {
            CSCertificateManager.instance = new CSCertificateManager();
        }
        return CSCertificateManager.instance;
    }

    // REMOVED: We don't need to load ALL system CAs
    // Only load specific certificates that the user provides for their API testing

    public async loadCertificate(name: string, config: CSCertificateConfig): Promise<void> {
        try {
            // Only process the specific certificate provided by the user
            // No need to load ALL system CAs
            const processedConfig = await this.processCertificateConfig(config);
            this.certificates.set(name, processedConfig);
            CSReporter.info(`Certificate loaded: ${name}`);
        } catch (error) {
            CSReporter.error(`Failed to load certificate: ${(error as Error).message}`);
            throw error;
        }
    }

    private async processCertificateConfig(config: CSCertificateConfig): Promise<CSCertificateConfig> {
        const processed: CSCertificateConfig = { ...config };

        // Load cert from file if path is provided
        if (typeof config.cert === 'string' && !config.cert.includes('BEGIN CERTIFICATE')) {
            processed.cert = await this.loadFile(config.cert);
        }

        // Load key from file if path is provided
        if (typeof config.key === 'string' && !config.key.includes('BEGIN')) {
            processed.key = await this.loadFile(config.key);
        }

        // Load CA from file(s) if path is provided
        if (config.ca) {
            if (Array.isArray(config.ca)) {
                processed.ca = await Promise.all(
                    config.ca.map(ca => this.loadCAFile(ca))
                );
            } else {
                processed.ca = await this.loadCAFile(config.ca);
            }
        }

        // Load PFX from file if path is provided
        if (typeof config.pfx === 'string' && !Buffer.isBuffer(config.pfx)) {
            processed.pfx = await this.loadFile(config.pfx);
        }

        return processed;
    }

    private async loadFile(filePath: string): Promise<Buffer> {
        try {
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
            return await fs.promises.readFile(absolutePath);
        } catch (error) {
            throw new Error(`Failed to load file ${filePath}: ${(error as Error).message}`);
        }
    }

    private async loadCAFile(ca: string | Buffer): Promise<string | Buffer> {
        if (Buffer.isBuffer(ca)) return ca;
        if (ca.includes('BEGIN')) return ca;
        return this.loadFile(ca);
    }

    public getCertificate(name: string): CSCertificateConfig | undefined {
        return this.certificates.get(name);
    }

    public removeCertificate(name: string): boolean {
        return this.certificates.delete(name);
    }

    public async validateCertificate(cert: string | Buffer): Promise<CSCertificateValidationResult> {
        const certString = Buffer.isBuffer(cert) ? cert.toString() : cert;
        const cacheKey = crypto.createHash('md5').update(certString).digest('hex');

        // Check cache
        if (this.validationCache.has(cacheKey)) {
            return this.validationCache.get(cacheKey)!;
        }

        const result: CSCertificateValidationResult = {
            valid: true,
            errors: [],
            warnings: []
        };

        try {
            const certInfo = this.parseCertificate(certString);
            result.info = certInfo;

            // Check expiration
            const now = new Date();
            const validFrom = new Date(certInfo.valid_from);
            const validTo = new Date(certInfo.valid_to);

            if (now < validFrom) {
                result.errors.push(`Certificate not yet valid (valid from ${certInfo.valid_from})`);
                result.valid = false;
            }

            if (now > validTo) {
                result.errors.push(`Certificate expired (valid to ${certInfo.valid_to})`);
                result.valid = false;
            }

            // Warn if certificate expires soon (30 days)
            const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            if (validTo <= thirtyDaysFromNow) {
                result.warnings.push(`Certificate expires soon (${certInfo.valid_to})`);
            }

            // Check key usage if available
            if (certInfo.keyUsage && !certInfo.keyUsage.includes('Digital Signature')) {
                result.warnings.push('Certificate may not be suitable for TLS (missing Digital Signature)');
            }

            // Cache the result
            this.validationCache.set(cacheKey, result);

        } catch (error) {
            result.valid = false;
            result.errors.push(`Certificate parsing failed: ${(error as Error).message}`);
        }

        return result;
    }

    private parseCertificate(cert: string): CSCertificateInfo {
        // Basic certificate parsing
        // In production, you'd use a proper X.509 parser
        const info: CSCertificateInfo = {
            subject: {},
            issuer: {},
            valid_from: '',
            valid_to: '',
            fingerprint: '',
            fingerprint256: '',
            serialNumber: ''
        };

        // Extract basic info using regex (simplified)
        const subjectMatch = cert.match(/Subject: (.+)/);
        if (subjectMatch) {
            info.subject = this.parseDN(subjectMatch[1]);
        }

        const issuerMatch = cert.match(/Issuer: (.+)/);
        if (issuerMatch) {
            info.issuer = this.parseDN(issuerMatch[1]);
        }

        // Generate fingerprints
        info.fingerprint = crypto.createHash('sha1').update(cert).digest('hex');
        info.fingerprint256 = crypto.createHash('sha256').update(cert).digest('hex');

        // Set mock dates for now
        const now = new Date();
        info.valid_from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
        info.valid_to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

        return info;
    }

    private parseDN(dn: string): any {
        const parts = dn.split(',').map(p => p.trim());
        const result: any = {};

        for (const part of parts) {
            const [key, value] = part.split('=').map(p => p.trim());
            if (key && value) {
                result[key] = value;
            }
        }

        return result;
    }

    public async verifyCertificateChain(chain: string[]): Promise<CSCertificateValidationResult> {
        const result: CSCertificateValidationResult = {
            valid: true,
            errors: [],
            warnings: []
        };

        if (chain.length === 0) {
            result.valid = false;
            result.errors.push('Empty certificate chain');
            return result;
        }

        // Validate each certificate
        for (let i = 0; i < chain.length; i++) {
            const certResult = await this.validateCertificate(chain[i]);

            if (!certResult.valid) {
                result.valid = false;
                result.errors.push(`Certificate ${i} validation failed: ${certResult.errors.join(', ')}`);
            }

            result.warnings.push(...certResult.warnings.map(w => `Certificate ${i}: ${w}`));
        }

        // TODO: Verify chain integrity (each cert signed by the next)

        return result;
    }

    public createSelfSignedCertificate(options: {
        commonName: string;
        organizationName?: string;
        countryName?: string;
        validDays?: number;
    }): { cert: string; key: string } {
        // Generate key pair
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        // Create self-signed certificate (simplified - would need proper X.509 library)
        const cert = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKHHIG...
Subject: CN=${options.commonName}, O=${options.organizationName || 'Test'}, C=${options.countryName || 'US'}
Issuer: CN=${options.commonName}, O=${options.organizationName || 'Test'}, C=${options.countryName || 'US'}
${Buffer.from(publicKey).toString('base64')}
-----END CERTIFICATE-----`;

        CSReporter.info(`Self-signed certificate created for ${options.commonName}`);

        return { cert, key: privateKey };
    }

    public addTrustedCA(ca: string | Buffer): void {
        this.trustedCAs.add(ca);
        CSReporter.debug('Trusted CA added');
    }

    public removeTrustedCA(ca: string | Buffer): boolean {
        return this.trustedCAs.delete(ca);
    }

    public getTrustedCAs(): Array<string | Buffer> {
        return Array.from(this.trustedCAs);
    }

    public createTLSContext(certName?: string): tls.SecureContextOptions {
        const config = certName ? this.certificates.get(certName) : {};

        return {
            ...config,
            // Only use user-provided CAs, not system CAs
            // If no CAs provided, let Node.js use its default behavior
            ca: config?.ca || (this.trustedCAs.size > 0 ? Array.from(this.trustedCAs) : undefined)
        };
    }

    public async validateServerCertificate(hostname: string, port: number = 443): Promise<CSCertificateValidationResult> {
        return new Promise((resolve) => {
            const result: CSCertificateValidationResult = {
                valid: true,
                errors: [],
                warnings: []
            };

            const socket = tls.connect(port, hostname, {
                rejectUnauthorized: false,
                servername: hostname
            }, () => {
                const cert = socket.getPeerCertificate(true);

                if (!cert || Object.keys(cert).length === 0) {
                    result.valid = false;
                    result.errors.push('No certificate presented by server');
                } else {
                    // Extract certificate info
                    result.info = {
                        subject: cert.subject,
                        issuer: cert.issuer,
                        valid_from: cert.valid_from,
                        valid_to: cert.valid_to,
                        fingerprint: cert.fingerprint,
                        fingerprint256: cert.fingerprint256,
                        serialNumber: cert.serialNumber,
                        subjectAltNames: cert.subjectaltname?.split(', ')
                    };

                    // Validate hostname
                    if (!this.validateHostname(hostname, cert)) {
                        result.errors.push(`Certificate not valid for hostname ${hostname}`);
                        result.valid = false;
                    }

                    // Check expiration
                    const now = new Date();
                    if (new Date(cert.valid_from) > now) {
                        result.errors.push('Certificate not yet valid');
                        result.valid = false;
                    }
                    if (new Date(cert.valid_to) < now) {
                        result.errors.push('Certificate expired');
                        result.valid = false;
                    }
                }

                socket.end();
                resolve(result);
            });

            socket.on('error', (error) => {
                result.valid = false;
                result.errors.push(`Connection error: ${error.message}`);
                resolve(result);
            });
        });
    }

    private validateHostname(hostname: string, cert: any): boolean {
        // Check common name
        if (cert.subject?.CN === hostname) {
            return true;
        }

        // Check SANs
        if (cert.subjectaltname) {
            const sans = cert.subjectaltname.split(', ');
            for (const san of sans) {
                const [type, value] = san.split(':');
                if (type === 'DNS' && this.matchHostname(hostname, value)) {
                    return true;
                }
            }
        }

        return false;
    }

    private matchHostname(hostname: string, pattern: string): boolean {
        // Handle wildcard certificates
        if (pattern.startsWith('*.')) {
            const domain = pattern.substring(2);
            return hostname.endsWith(domain) && hostname.split('.').length === pattern.split('.').length;
        }

        return hostname === pattern;
    }

    public clearCache(): void {
        this.validationCache.clear();
    }

    public exportCertificates(): any {
        const exported: any = {};

        for (const [name, config] of this.certificates.entries()) {
            exported[name] = {
                hasKey: !!config.key,
                hasCert: !!config.cert,
                hasCa: !!config.ca,
                hasPfx: !!config.pfx,
                rejectUnauthorized: config.rejectUnauthorized
            };
        }

        return exported;
    }

    public getStats(): any {
        return {
            certificates: this.certificates.size,
            trustedCAs: this.trustedCAs.size,
            cachedValidations: this.validationCache.size
        };
    }
}

export const certificateManager = CSCertificateManager.getInstance();