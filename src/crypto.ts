// AES-GCM for stored Gmail tokens, HMAC-SHA256 for signed cookies and OAuth state.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

async function aesKey(secretB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(secretB64);
  if (raw.length !== 32) throw new Error("key must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts stored secrets (Gmail refresh tokens). `context` binds a ciphertext to one user,
 * so a token copied onto another user's record won't decrypt.
 * Production uses AWS KMS (src/aws/kms.ts); local dev uses LocalCipher below.
 */
export interface TokenCipher {
  encrypt(plain: string, context: string): Promise<string>;
  decrypt(packed: string, context: string): Promise<string>;
}

/** AES-GCM with a key held in memory. For local dev and tests only. */
export class LocalCipher implements TokenCipher {
  constructor(private secretB64: string) {}

  async encrypt(plain: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(context) },
      await aesKey(this.secretB64),
      enc.encode(plain),
    );
    return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
  }

  async decrypt(packed: string, context: string): Promise<string> {
    const [ivPart, ctPart] = packed.split(".");
    if (!ivPart || !ctPart) throw new Error("bad ciphertext");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlToBytes(ivPart), additionalData: enc.encode(context) },
      await aesKey(this.secretB64),
      b64urlToBytes(ctPart),
    );
    return dec.decode(pt);
  }
}

export function randomKeyB64(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmacKey(secretB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64ToBytes(secretB64), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Signs a JSON payload: "payload.signature", both base64url. */
export async function signPayload(payload: unknown, secretB64: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secretB64), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyPayload<T>(token: string, secretB64: string): Promise<T | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secretB64), b64urlToBytes(sig), enc.encode(body));
  if (!ok) return null;
  try {
    return JSON.parse(dec.decode(b64urlToBytes(body))) as T;
  } catch {
    return null;
  }
}

export function randomId(prefix = ""): string {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(12)));
}
