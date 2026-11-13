import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Random bearer secret (sessions, device tokens). Only its SHA-256 is stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Short human-typeable code shown in the web UI and typed into the bridge. */
export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizePairingCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
