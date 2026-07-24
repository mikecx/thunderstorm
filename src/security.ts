import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

const KEYLEN = 64;

/**
 * Hashes a password with a random per-password salt using Node's built-in
 * `scrypt` — no bcrypt dependency needed. Async (not `scryptSync`) so
 * hashing doesn't block the event loop under concurrent requests.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, KEYLEN);
  return `${salt}:${derived.toString('hex')}`;
}

/** Verifies a password against a digest produced by hashPassword(), using a timing-safe comparison. */
export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  const [salt, storedHex] = digest.split(':');
  if (!salt || !storedHex) return false;
  const stored = Buffer.from(storedHex, 'hex');
  const derived = await scryptAsync(password, salt, stored.length);
  return derived.length === stored.length && timingSafeEqual(derived, stored);
}

/** A random URL-safe token, e.g. for API keys or invite links. */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
