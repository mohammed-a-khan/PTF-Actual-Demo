/**
 * Kerberos / Negotiate (SPNEGO) sign-in: the token comes from the operating system's sign-in (Windows: SSPI with
 * the signed-in user, no password; elsewhere: GSSAPI with a ticket from kinit). The native `kerberos` package does
 * the work; it is loaded only when a request uses Negotiate (optional: install it where Kerberos is used).
 */
export interface NegotiateClient { step(challenge: string): Promise<string> }
export type NegotiateFactory = (service: string) => Promise<NegotiateClient>;

let factory: NegotiateFactory | null = null;

/** Tests (and other back ends): replace how the token is made. */
export function setNegotiateFactory(f: NegotiateFactory | null): void { factory = f; }

/** A client for HTTP@host (the service principal of the web server). */
export async function negotiateClient(host: string, spn?: string): Promise<NegotiateClient> {
    const service = spn || `HTTP@${host}`;
    if (factory) return factory(service);
    let k: { initializeClient: (s: string, o: Record<string, unknown>) => Promise<{ step: (c: string) => Promise<string> }>; GSS_MECH_OID_SPNEGO: unknown };
    try { k = require('kerberos'); } // eslint-disable-line @typescript-eslint/no-require-imports
    catch { throw new Error('Kerberos (Negotiate) needs the "kerberos" package on this computer: run "npm install kerberos" in the Studio folder (it comes with ready-built Windows binaries).'); }
    const c = await k.initializeClient(service, { mechOID: k.GSS_MECH_OID_SPNEGO });
    return { step: (challenge) => c.step(challenge) };
}
