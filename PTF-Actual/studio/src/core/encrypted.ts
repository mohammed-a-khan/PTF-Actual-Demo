/** ENCRYPTED: values of the framework (utils/CSEncryptionUtil): which key made one. */
/** The id of the team's key an ENCRYPTED: value was made with (CS_ENCRYPTION_KEY), or null (the built-in key / not readable). */
export function encryptedKeyId(raw: string): string | null {
    try {
        const d = JSON.parse(Buffer.from(raw.replace(/^ENCRYPTED:/, '').trim(), 'base64').toString('utf8'));
        return typeof d?.kid === 'string' && /^[0-9a-f]{6,64}$/.test(d.kid) ? d.kid : null;
    } catch { return null; }
}
