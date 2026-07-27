import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import type { Caster } from './casters';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface EncryptedCasterOptions {
  /**
   * Keys to try, in order, when decrypting — supports rotation: put the new
   * key first (used for all new encryption) and keep old keys after it so
   * existing rows still decrypt under the key they were written with. Each
   * key must be exactly 32 bytes (AES-256).
   */
  keys: Buffer[];
  /**
   * Same plaintext + same key always produces the same ciphertext, so
   * `WHERE column = ?` (and `@Validates({ uniqueness })`) still match against
   * the encrypted column — at the cost of leaking equality: an attacker who
   * can read ciphertexts can tell which rows share a value, and on
   * low-cardinality data (a small enumerable set of possible plaintexts,
   * e.g. a country code) can guess values by comparing ciphertexts against
   * ones they've computed themselves. Rotating `keys` breaks queryability
   * against rows still encrypted under an older key — they'll still decrypt
   * fine, but a `where()` comparison encrypted under the new (first) key
   * won't match them until those rows are re-encrypted. Default: `false`
   * (non-deterministic — safer, but not queryable at all).
   */
  deterministic?: boolean;
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (AES-256), got ${key.length}.`);
  }
}

/**
 * A fixed-per-plaintext IV, derived via HMAC rather than reused literally —
 * different plaintexts still get (effectively) unique IVs, avoiding GCM's
 * catastrophic same-IV-different-plaintext failure mode, while identical
 * plaintexts under the same key always produce the same IV (and therefore
 * the same ciphertext), which is exactly what makes deterministic mode
 * queryable.
 */
function deterministicIv(key: Buffer, plaintext: string): Buffer {
  return createHmac('sha256', key).update(plaintext).digest().subarray(0, IV_LENGTH);
}

function encryptWith(key: Buffer, plaintext: string, deterministic: boolean): string {
  const iv = deterministic ? deterministicIv(key, plaintext) : randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptWith(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Transparent column encryption via AES-256-GCM, using Node's built-in
 * `crypto` — no external dependency, same ethos as `security.ts`'s password
 * hashing. There's no separate decorator for this: `ColumnOptions.type`
 * already accepts any `Caster`, and encryption is exactly a load/save
 * transform like any other caster —
 * `@Column({ type: encryptedCaster({ keys: [key] }) })`.
 */
export function encryptedCaster(options: EncryptedCasterOptions): Caster<string> {
  const { keys, deterministic = false } = options;
  if (keys.length === 0) {
    throw new Error('encryptedCaster requires at least one key.');
  }
  keys.forEach(assertKeyLength);
  const [currentKey] = keys;

  return {
    save(value) {
      if (value == null) return value;
      return encryptWith(currentKey, String(value), deterministic);
    },
    load(value) {
      if (value == null) return value;
      const blob = Buffer.from(String(value), 'base64');
      for (const key of keys) {
        try {
          return decryptWith(key, blob);
        } catch {
          // wrong key for this row — fall through and try the next one (rotation)
        }
      }
      throw new Error('Could not decrypt column: no configured key matched.');
    },
  };
}
