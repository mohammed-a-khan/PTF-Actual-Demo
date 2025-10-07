import * as crypto from 'crypto';

export class CSEncryptionUtil {
    private static instance: CSEncryptionUtil;
    private readonly INTERNAL_KEY = 'CS-Framework-2024-Internal-Encryption-Key-V1';
    private readonly SALT = 'CS-Framework-Salt';
    private readonly ITERATIONS = 10000;
    private readonly ALGORITHM = 'aes-256-gcm';

    private constructor() {
        // Private constructor for singleton
    }

    public static getInstance(): CSEncryptionUtil {
        if (!CSEncryptionUtil.instance) {
            CSEncryptionUtil.instance = new CSEncryptionUtil();
        }
        return CSEncryptionUtil.instance;
    }

    public encrypt(text: string): string {
        try {
            // Generate random IV
            const iv = crypto.randomBytes(16);
            
            // Derive key using PBKDF2
            const key = crypto.pbkdf2Sync(
                this.INTERNAL_KEY,
                this.SALT,
                this.ITERATIONS,
                32,
                'sha256'
            );
            
            // Create cipher
            const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
            
            // Encrypt the text
            let encrypted = cipher.update(text, 'utf8');
            encrypted = Buffer.concat([encrypted, cipher.final()]);
            
            // Get the authentication tag
            const tag = cipher.getAuthTag();
            
            // Create the encryption object matching the HTML tool format
            const encryptionData = {
                encrypted: encrypted.toString('base64'),
                iv: iv.toString('base64'),
                tag: tag.toString('base64')
            };
            
            // Base64 encode the JSON object
            const base64Result = Buffer.from(JSON.stringify(encryptionData)).toString('base64');
            
            // Return with ENCRYPTED: prefix
            return `ENCRYPTED:${base64Result}`;
        } catch (error: any) {
            console.error(`Encryption failed: ${error.message}`);
            return text;
        }
    }

    public decrypt(encryptedText: string): string {
        try {
            // Return empty if input is invalid
            if (!encryptedText || encryptedText.trim() === '') {
                return '';
            }
            
            // Remove ENCRYPTED: prefix if present
            if (encryptedText.startsWith('ENCRYPTED:')) {
                encryptedText = encryptedText.substring('ENCRYPTED:'.length);
            }
            
            // Validate base64 format before attempting to parse
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedText)) {
                return '';
            }
            
            // Decode the base64 JSON
            let decodedData: string;
            try {
                decodedData = Buffer.from(encryptedText, 'base64').toString('utf8');
            } catch {
                return '';
            }
            
            // Validate JSON format before parsing
            if (!decodedData.startsWith('{') || !decodedData.endsWith('}')) {
                return '';
            }
            
            const encryptionData = JSON.parse(decodedData);
            
            // Validate required fields
            if (!encryptionData.encrypted || !encryptionData.iv || !encryptionData.tag) {
                return '';
            }
            
            // Decode the components from base64
            const encrypted = Buffer.from(encryptionData.encrypted, 'base64');
            const iv = Buffer.from(encryptionData.iv, 'base64');
            const tag = Buffer.from(encryptionData.tag, 'base64');
            
            // Derive key using PBKDF2
            const key = crypto.pbkdf2Sync(
                this.INTERNAL_KEY,
                this.SALT,
                this.ITERATIONS,
                32,
                'sha256'
            );
            
            // Create decipher
            const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
            decipher.setAuthTag(tag);
            
            // Decrypt the text
            let decrypted = decipher.update(encrypted);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            
            return decrypted.toString('utf8');
        } catch (error: any) {
            // Silently fail - return empty string for security
            // This happens when trying to decrypt non-encrypted values
            return '';
        }
    }

    public isEncrypted(value: string): boolean {
        return typeof value === 'string' && value.startsWith('ENCRYPTED:');
    }

    public generateSecurePassword(): string {
        const length = 12;
        const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        
        for (let i = 0; i < length; i++) {
            const randomIndex = crypto.randomInt(0, charset.length);
            password += charset[randomIndex];
        }
        
        return password;
    }

    public hashPassword(password: string): string {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        return `${salt}:${hash}`;
    }

    public verifyPassword(password: string, hashedPassword: string): boolean {
        const [salt, hash] = hashedPassword.split(':');
        const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        return hash === verifyHash;
    }

    /**
     * Create an encrypted value that can be used in config files
     * Useful for generating encrypted passwords and tokens
     */
    public createEncryptedConfigValue(plainText: string): string {
        return this.encrypt(plainText);
    }

    /**
     * Batch encrypt multiple values
     */
    public encryptMultiple(values: Record<string, string>): Record<string, string> {
        const encrypted: Record<string, string> = {};
        for (const [key, value] of Object.entries(values)) {
            encrypted[key] = this.encrypt(value);
        }
        return encrypted;
    }
}