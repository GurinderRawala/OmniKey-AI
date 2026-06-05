import crypto from 'crypto';
import { config } from './config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM

function getKey(): Buffer {
  const key = config.appEncryptionKey;
  if (!key) {
    throw new Error('APP_ENCRYPTION_KEY is not set. It must be a 32-byte base64 string.');
  }

  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM.');
  }
  return buf;
}

export function encryptToBase64(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Store as iv || authTag || ciphertext, all base64-encoded in one string
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

export function decryptFromBase64(cipherText: string): string {
  const key = getKey();
  const combined = Buffer.from(cipherText, 'base64');

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = combined.subarray(IV_LENGTH + 16);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
