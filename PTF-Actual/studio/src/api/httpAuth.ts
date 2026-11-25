/**
 * Challenge-response HTTP authentication, dependency-free (shared by the Studio and the framework):
 *
 *  - NTLM (NTLMv2, MS-NLMP): Type 1 (negotiate) → the server's Type 2 (challenge, in WWW-Authenticate) → Type 3
 *    (authenticate). The three messages must go over one kept-alive connection. MD4 is implemented here: OpenSSL 3
 *    builds (Node 17+) usually refuse it.
 *  - Digest (RFC 7616 / 2617): MD5, MD5-sess, SHA-256, SHA-256-sess; qop "auth" (or none); opaque; nonce count.
 *
 * Checked against the specifications' examples (MS-NLMP 4.2.4, RFC 2617 3.5, RFC 7616 3.9.1).
 */
import * as crypto from 'crypto';

// ---- MD4 (RFC 1320)

export function md4(data: Buffer): Buffer {
    const len = data.length;
    const words = ((len + 8) >>> 6) + 1;
    const x = new Uint32Array(words * 16);
    for (let i = 0; i < len; i++) x[i >> 2] |= data[i] << ((i % 4) * 8);
    x[len >> 2] |= 0x80 << ((len % 4) * 8);
    x[words * 16 - 2] = (len * 8) >>> 0;
    x[words * 16 - 1] = Math.floor((len * 8) / 0x100000000) >>> 0;
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    const rol = (v: number, s: number) => ((v << s) | (v >>> (32 - s))) >>> 0;
    const F = (p: number, q: number, r: number) => (p & q) | (~p & r);
    const G = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
    const H = (p: number, q: number, r: number) => p ^ q ^ r;
    for (let i = 0; i < x.length; i += 16) {
        const [aa, bb, cc, dd] = [a, b, c, d];
        const r1 = (p: number, q: number, r: number, s: number, k: number, sh: number) => rol((p + F(q, r, s) + x[i + k]) >>> 0, sh);
        const r2 = (p: number, q: number, r: number, s: number, k: number, sh: number) => rol((p + G(q, r, s) + x[i + k] + 0x5a827999) >>> 0, sh);
        const r3 = (p: number, q: number, r: number, s: number, k: number, sh: number) => rol((p + H(q, r, s) + x[i + k] + 0x6ed9eba1) >>> 0, sh);
        for (const k of [0, 4, 8, 12]) { a = r1(a, b, c, d, k, 3); d = r1(d, a, b, c, k + 1, 7); c = r1(c, d, a, b, k + 2, 11); b = r1(b, c, d, a, k + 3, 19); }
        for (const k of [0, 1, 2, 3]) { a = r2(a, b, c, d, k, 3); d = r2(d, a, b, c, k + 4, 5); c = r2(c, d, a, b, k + 8, 9); b = r2(b, c, d, a, k + 12, 13); }
        for (const k of [0, 2, 1, 3]) { a = r3(a, b, c, d, k, 3); d = r3(d, a, b, c, k + 8, 9); c = r3(c, d, a, b, k + 4, 11); b = r3(b, c, d, a, k + 12, 15); }
        a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0;
    }
    const out = Buffer.alloc(16);
    out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4); out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
    return out;
}

// ---- NTLM

const hmacMd5 = (key: Buffer, data: Buffer) => crypto.createHmac('md5', key).update(data).digest();
const utf16 = (s: string) => Buffer.from(s, 'utf16le');

const NEGOTIATE_UNICODE = 0x00000001, REQUEST_TARGET = 0x00000004, NEGOTIATE_NTLM = 0x00000200,
    ALWAYS_SIGN = 0x00008000, EXTENDED_SESSIONSECURITY = 0x00080000, NEGOTIATE_TARGET_INFO = 0x00800000,
    NEGOTIATE_128 = 0x20000000, NEGOTIATE_56 = 0x80000000;
const TYPE1_FLAGS = (NEGOTIATE_UNICODE | REQUEST_TARGET | NEGOTIATE_NTLM | ALWAYS_SIGN | EXTENDED_SESSIONSECURITY | NEGOTIATE_TARGET_INFO | NEGOTIATE_128 | NEGOTIATE_56) >>> 0;
const SIGNATURE = Buffer.from('NTLMSSP\0', 'ascii');

/** The Type 1 (negotiate) message, base64, for "Authorization: NTLM …". */
export function ntlmType1(): string {
    const b = Buffer.alloc(32);
    SIGNATURE.copy(b, 0);
    b.writeUInt32LE(1, 8);
    b.writeUInt32LE(TYPE1_FLAGS, 12);
    // Domain and workstation: empty (offsets past the header).
    b.writeUInt32LE(32, 20); b.writeUInt32LE(32, 28);
    return b.toString('base64');
}

export interface NtlmChallenge { challenge: Buffer; flags: number; targetInfo: Buffer; targetName: string }

/** The server's Type 2 message (from "WWW-Authenticate: NTLM <base64>"). */
export function ntlmParseType2(header: string): NtlmChallenge {
    const m = /NTLM\s+([A-Za-z0-9+/=]+)/i.exec(header);
    if (!m) throw new Error('The server did not send an NTLM challenge.');
    const b = Buffer.from(m[1], 'base64');
    if (b.length < 32 || !b.subarray(0, 8).equals(SIGNATURE) || b.readUInt32LE(8) !== 2) throw new Error('The NTLM challenge is not valid.');
    const flags = b.readUInt32LE(20);
    const field = (at: number) => { const len = b.readUInt16LE(at), off = b.readUInt32LE(at + 4); return off + len <= b.length ? b.subarray(off, off + len) : Buffer.alloc(0); };
    const tn = field(12);
    return { challenge: Buffer.from(b.subarray(24, 32)), flags, targetInfo: b.length >= 48 ? Buffer.from(field(40)) : Buffer.alloc(0), targetName: flags & NEGOTIATE_UNICODE ? tn.toString('utf16le') : tn.toString('latin1') };
}

/** NTOWFv2: HMAC-MD5(MD4(UTF-16LE(password)), UTF-16LE(UPPER(user) + domain)). */
export function ntowfv2(user: string, password: string, domain: string): Buffer {
    return hmacMd5(md4(utf16(password)), utf16(user.toUpperCase() + domain));
}

/** The NTLMv2 response (NTProofStr + blob) and the LMv2 response. */
export function ntlmv2Responses(o: { user: string; password: string; domain: string; serverChallenge: Buffer; targetInfo: Buffer; clientChallenge?: Buffer; time?: Buffer }) {
    const key = ntowfv2(o.user, o.password, o.domain);
    const client = o.clientChallenge ?? crypto.randomBytes(8);
    // Time: 100 ns intervals since 1601-01-01 (Windows FILETIME), little endian.
    const time = o.time ?? (() => { const t = BigInt(Date.now() + 11644473600000) * 10000n; const b = Buffer.alloc(8); b.writeBigUInt64LE(t); return b; })();
    const blob = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), time, client, Buffer.alloc(4), o.targetInfo, Buffer.alloc(4)]);
    const proof = hmacMd5(key, Buffer.concat([o.serverChallenge, blob]));
    const lm = Buffer.concat([hmacMd5(key, Buffer.concat([o.serverChallenge, client])), client]);
    return { nt: Buffer.concat([proof, blob]), lm, proof };
}

/** The Type 3 (authenticate) message, base64, answering the server's challenge. "DOMAIN\\user" or "user@domain" accepted. */
export function ntlmType3(type2: NtlmChallenge, username: string, password: string, domain = '', workstation = ''): string {
    let user = username, dom = domain;
    const bs = /^([^\\]+)\\(.+)$/.exec(username), at = /^([^@]+)@(.+)$/.exec(username);
    if (bs) { dom = dom || bs[1]; user = bs[2]; } else if (at && !domain) { user = at[1]; dom = at[2]; }
    if (!dom) dom = type2.targetName;
    const { nt, lm } = ntlmv2Responses({ user, password, domain: dom, serverChallenge: type2.challenge, targetInfo: type2.targetInfo });
    const fields = [lm, nt, utf16(dom), utf16(user), utf16(workstation.toUpperCase()), Buffer.alloc(0)];
    const header = Buffer.alloc(64);
    SIGNATURE.copy(header, 0);
    header.writeUInt32LE(3, 8);
    let off = 64;
    fields.forEach((f, i) => { const at2 = 12 + i * 8; header.writeUInt16LE(f.length, at2); header.writeUInt16LE(f.length, at2 + 2); header.writeUInt32LE(off, at2 + 4); off += f.length; });
    header.writeUInt32LE(((type2.flags & TYPE1_FLAGS) | NEGOTIATE_UNICODE | NEGOTIATE_NTLM) >>> 0, 60);
    return Buffer.concat([header, ...fields]).toString('base64');
}

// ---- Digest

export interface DigestChallenge { realm: string; nonce: string; qop?: string; opaque?: string; algorithm: string; stale?: boolean }

/** The Digest challenge of a WWW-Authenticate header (the first one offering a supported algorithm). */
export function parseDigest(header: string): DigestChallenge | null {
    const all = [...header.matchAll(/Digest\s+((?:[a-zA-Z-]+=(?:"[^"]*"|[^,\s]*)\s*,?\s*)+)/g)];
    for (const m of all) {
        const p: Record<string, string> = {};
        for (const kv of m[1].matchAll(/([a-zA-Z-]+)=(?:"([^"]*)"|([^,\s]*))/g)) p[kv[1].toLowerCase()] = kv[2] ?? kv[3];
        const algorithm = (p.algorithm || 'MD5').toUpperCase();
        if (!['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(algorithm) || !p.nonce) continue;
        return { realm: p.realm ?? '', nonce: p.nonce, qop: p.qop, opaque: p.opaque, algorithm, stale: /^true$/i.test(p.stale ?? '') };
    }
    return null;
}

/** The Authorization header answering a Digest challenge. */
export function digestAuthorization(c: DigestChallenge, o: { username: string; password: string; method: string; uri: string; nc?: number; cnonce?: string }): string {
    const hash = (s: string) => crypto.createHash(c.algorithm.startsWith('SHA-256') ? 'sha256' : 'md5').update(s).digest('hex');
    const qop = c.qop ? (c.qop.split(',').map((x) => x.trim()).includes('auth') ? 'auth' : null) : undefined;
    if (qop === null) throw new Error(`The server asks for Digest qop "${c.qop}", only "auth" is supported.`);
    const cnonce = o.cnonce ?? crypto.randomBytes(8).toString('hex');
    const nc = (o.nc ?? 1).toString(16).padStart(8, '0');
    let ha1 = hash(`${o.username}:${c.realm}:${o.password}`);
    if (c.algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${c.nonce}:${cnonce}`);
    const ha2 = hash(`${o.method.toUpperCase()}:${o.uri}`);
    const response = qop ? hash(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${c.nonce}:${ha2}`);
    const parts = [`username="${o.username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${o.uri}"`, `algorithm=${c.algorithm}`, `response="${response}"`];
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (c.opaque !== undefined) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(', ')}`;
}

// ---- AWS Signature Version 4

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Input {
    method: string; url: string; headers?: Record<string, string>; body?: string | Buffer;
    accessKeyId: string; secretAccessKey: string; sessionToken?: string;
    region: string; service: string;
    /** For tests: the signing time. */
    date?: Date;
}

/**
 * AWS Signature Version 4: the headers to add (Authorization, X-Amz-Date, X-Amz-Security-Token,
 * X-Amz-Content-Sha256 for S3). Canonical request per the AWS documentation: path segments URI-encoded (twice except
 * for S3), query sorted by name then value and RFC 3986 encoded, host (with a non-default port), x-amz-* and
 * content-type headers signed, the payload hashed.
 */
export function sigv4(o: SigV4Input): Record<string, string> {
    const u = new URL(o.url);
    const amzDate = (o.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(o.body ?? '').digest('hex');
    const s3 = o.service === 's3';
    const add: Record<string, string> = { 'X-Amz-Date': amzDate };
    if (o.sessionToken) add['X-Amz-Security-Token'] = o.sessionToken;
    if (s3) add['X-Amz-Content-Sha256'] = payloadHash;
    const all: Record<string, string> = { ...(o.headers ?? {}), ...add, host: u.host };
    const signed = Object.entries(all)
        .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as [string, string])
        .filter(([k]) => k === 'host' || k.startsWith('x-amz-') || k === 'content-type' || k === 'content-md5')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const segs = u.pathname.split('/').map((p) => { let raw = p; try { raw = decodeURIComponent(p); } catch { /* as is */ } const once = rfc3986(raw); return s3 ? once : rfc3986(once); });
    const canonicalPath = segs.join('/') || '/';
    const query = [...u.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
    const canonical = [o.method.toUpperCase(), canonicalPath, query, signed.map(([k, v]) => `${k}:${v}\n`).join(''), signed.map(([k]) => k).join(';'), payloadHash].join('\n');
    const scope = `${day}/${o.region}/${o.service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
    const h = (k: Buffer | string, d: string) => crypto.createHmac('sha256', k).update(d).digest();
    const key = h(h(h(h(`AWS4${o.secretAccessKey}`, day), o.region), o.service), 'aws4_request');
    const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
    return { ...add, Authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed.map(([k]) => k).join(';')}, Signature=${signature}` };
}

// ---- JWT (signed tokens)

const JWT_ALGS: Record<string, { kind: 'hmac' | 'rsa' | 'pss' | 'ec'; hash: string }> = {
    HS256: { kind: 'hmac', hash: 'sha256' }, HS384: { kind: 'hmac', hash: 'sha384' }, HS512: { kind: 'hmac', hash: 'sha512' },
    RS256: { kind: 'rsa', hash: 'sha256' }, RS384: { kind: 'rsa', hash: 'sha384' }, RS512: { kind: 'rsa', hash: 'sha512' },
    PS256: { kind: 'pss', hash: 'sha256' }, PS384: { kind: 'pss', hash: 'sha384' }, PS512: { kind: 'pss', hash: 'sha512' },
    ES256: { kind: 'ec', hash: 'sha256' }, ES384: { kind: 'ec', hash: 'sha384' }, ES512: { kind: 'ec', hash: 'sha512' },
};
export const JWT_ALGORITHMS = Object.keys(JWT_ALGS);

/** A signed JWT: HS256-512 with a shared secret, RS256-512 and PS256-512 with an RSA private key (PEM), ES256-512 with an EC private key (PEM). */
export function signJwt(alg: string, key: string | Buffer, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
    const a = JWT_ALGS[alg];
    if (!a) throw new Error(`JWT algorithm ${alg} is not supported (${JWT_ALGORITHMS.join(', ')}).`);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc({ alg, typ: 'JWT', ...header })}.${enc(claims)}`;
    let sig: Buffer;
    if (a.kind === 'hmac') sig = crypto.createHmac(a.hash, key).update(input).digest();
    else if (a.kind === 'pss') sig = crypto.sign(a.hash, Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
    else if (a.kind === 'ec') sig = crypto.sign(a.hash, Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    else sig = crypto.sign(a.hash, Buffer.from(input), key);
    return `${input}.${sig.toString('base64url')}`;
}
