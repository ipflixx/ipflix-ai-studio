/**
 * Client-side AES-256-GCM zero-plaintext vault cryptography.
 *
 * Security guarantees:
 * 1. On Secure Contexts (HTTPS / localhost / Electron): uses native Web Crypto API
 *    AES-256-GCM with a non-extractable CryptoKey persisted in IndexedDB `crypto_keys`.
 * 2. On Local-Network HTTP (e.g. Android phone or Android TV browsers accessing
 *    `http://192.168.x.x:3000` where browsers disable `crypto.subtle`):
 *    uses audited NIST SP 800-38D AES-256-GCM via `@noble/ciphers/aes.js` with a
 *    256-bit CSPRNG key (`crypto.getRandomValues`) stored in IndexedDB `crypto_keys`.
 * 3. Wire format (`v1:<iv_b64>:<ciphertext_and_tag_b64>`) is 100% identical and
 *    interoperable across both engines. Sensitive credentials (IPTV passwords, M3U/EPG URLs,
 *    and Profile PINs) are NEVER stored in plaintext.
 */

import { gcm } from '@noble/ciphers/aes.js';

const VAULT_TOKEN_PREFIX = 'v1:';

export type DeviceVaultKey =
  | { kind: 'webcrypto'; key: CryptoKey }
  | { kind: 'noble'; rawKey: Uint8Array };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function getRandomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
    return buf;
  }
  throw new Error('Cryptographically secure random generator (crypto.getRandomValues) is unavailable.');
}

export function isWebCryptoSubtleAvailable(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    Boolean(crypto.subtle) &&
    typeof crypto.subtle.generateKey === 'function' &&
    typeof crypto.subtle.encrypt === 'function' &&
    typeof crypto.subtle.decrypt === 'function'
  );
}

export function isCsprngAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';
}

/**
 * Generates a non-extractable AES-256-GCM CryptoKey for secure contexts
 * (HTTPS / localhost / Electron).
 */
export async function generateDeviceAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Generates a cryptographically strong 256-bit AES-GCM key using `crypto.getRandomValues`
 * for non-secure LAN HTTP contexts (e.g. Android phone / Android TV browsers over LAN).
 */
export function generateRawDeviceAesKey(): Uint8Array {
  return getRandomBytes(32);
}

/**
 * Synchronously encrypts a JSON payload with a raw AES-256-GCM key (`@noble/ciphers`).
 * Produces the exact same wire format (`v1:<iv>:<ciphertext||authTag>`) as Web Crypto AES-256-GCM.
 */
export function encryptJsonWithRawAesKeySync(rawKey: Uint8Array, payload: unknown): string {
  const iv = getRandomBytes(12);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = gcm(rawKey, iv).encrypt(encoded);
  return `${VAULT_TOKEN_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(encrypted)}`;
}

/**
 * Synchronously decrypts a `v1:` AES-256-GCM token using a raw 256-bit key (`@noble/ciphers`).
 */
export function decryptJsonWithRawAesKeySync<T>(rawKey: Uint8Array, token: string): T | null {
  if (!token || !token.startsWith(VAULT_TOKEN_PREFIX)) return null;
  const parts = token.slice(VAULT_TOKEN_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    const iv = base64ToBytes(parts[0]);
    const ct = base64ToBytes(parts[1]);
    const decrypted = gcm(rawKey, iv).decrypt(ct);
    const text = new TextDecoder().decode(decrypted);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function encryptJsonWithKey(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = getRandomBytes(12);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    encoded
  );
  return `${VAULT_TOKEN_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptJsonWithKey<T>(key: CryptoKey, token: string): Promise<T | null> {
  if (!token || !token.startsWith(VAULT_TOKEN_PREFIX)) return null;
  const parts = token.slice(VAULT_TOKEN_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    const iv = base64ToBytes(parts[0]);
    const ct = base64ToBytes(parts[1]);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ct as BufferSource
    );
    const text = new TextDecoder().decode(decrypted);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function encryptJsonWithDeviceKey(
  deviceKey: DeviceVaultKey,
  payload: unknown
): Promise<string> {
  if (deviceKey.kind === 'webcrypto') {
    return encryptJsonWithKey(deviceKey.key, payload);
  }
  return encryptJsonWithRawAesKeySync(deviceKey.rawKey, payload);
}

export async function decryptJsonWithDeviceKey<T>(
  deviceKey: DeviceVaultKey,
  token: string
): Promise<T | null> {
  if (deviceKey.kind === 'webcrypto') {
    return decryptJsonWithKey<T>(deviceKey.key, token);
  }
  return decryptJsonWithRawAesKeySync<T>(deviceKey.rawKey, token);
}
