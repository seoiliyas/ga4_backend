// ── Cryptographic helpers: password hashing, tokens, AES-GCM, HMAC state ──────

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str: string): Uint8Array | null {
  if (!str || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
  try {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export async function sha256Hex(input: string, maxLength?: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const hex = bytesToHex(new Uint8Array(digest));
  return maxLength ? hex.slice(0, maxLength) : hex;
}

// ── Password hashing (Web Crypto PBKDF2) ──────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return `${bytesToHex(salt)}:${bytesToHex(new Uint8Array(derivedBits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || !stored.includes(':')) return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, expectedHashHex] = parts;
  const salt = hexToBytes(saltHex);
  const expectedHash = hexToBytes(expectedHashHex);
  if (!salt || !expectedHash || expectedHash.length !== KEY_LENGTH) return false;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return timingSafeEqual(new Uint8Array(derivedBits), expectedHash);
}

// ── Token generation ──────────────────────────────────────────────────────────

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

export function generateInviteKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return 'INV-' + bytesToHex(bytes).toUpperCase();
}

export function generateUserId(): string {
  return crypto.randomUUID();
}

// ── AES-GCM Token Encryption ──────────────────────────────────────────────────

export async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function deriveLegacyEncryptionKey(secret: string): Promise<CryptoKey> {
  const raw = encoder.encode(secret.padEnd(32, '0').slice(0, 32)).slice(0, 32);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

export async function encryptToken(plaintext: string, secret: string): Promise<string> {
  const key = await deriveEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(encrypted))}`;
}

export async function decryptToken(stored: string, secret: string): Promise<string> {
  if (!stored || !stored.includes(':')) {
    throw new Error('Malformed encrypted token');
  }
  const parts = stored.split(':');
  if (parts.length !== 2) {
    throw new Error('Malformed encrypted token');
  }
  const iv = hexToBytes(parts[0]);
  const ct = hexToBytes(parts[1]);
  if (!iv || !ct || iv.length !== 12) {
    throw new Error('Malformed encrypted token payload');
  }

  const key = await deriveEncryptionKey(secret);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return decoder.decode(decrypted);
  } catch {
    // Fallback for tokens encrypted prior to SHA-256 key derivation
    const legacyKey = await deriveLegacyEncryptionKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, legacyKey, ct);
    return decoder.decode(decrypted);
  }
}

// ── HMAC-SHA256 Signed OAuth State ────────────────────────────────────────────

async function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export async function signState(payload: object, secret: string): Promise<string> {
  const dataBytes = encoder.encode(JSON.stringify(payload));
  const dataB64 = bytesToBase64Url(dataBytes);
  const key = await importHmacKey(secret, 'sign');
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(dataB64));
  const sigB64 = bytesToBase64Url(new Uint8Array(sigBuf));
  return `${dataB64}.${sigB64}`;
}

export async function verifyState<T = Record<string, unknown>>(
  state: string,
  secret: string,
): Promise<T | null> {
  if (!state || !state.includes('.')) return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [dataB64, sigB64] = parts;

  const sigBytes = base64UrlToBytes(sigB64);
  const dataBytes = base64UrlToBytes(dataB64);
  if (!sigBytes || !dataBytes) return null;

  const key = await importHmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(dataB64));
  if (!valid) {
    return null;
  }

  try {
    return JSON.parse(decoder.decode(dataBytes)) as T;
  } catch {
    return null;
  }
}
