import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

export type CredentialCipher = {
  available: boolean;
  encrypt: (value: string) => string | undefined;
  decrypt: (value: string) => string | undefined;
};

/**
 * Creates the process-local credential cipher. A malformed/missing key is an
 * unavailable credential condition, not a process-startup failure.
 */
export function createCredentialCipher(key = process.env.MCP_CREDENTIALS_KEY): CredentialCipher {
  const keyBytes = decodeKey(key);

  return {
    available: keyBytes !== undefined,
    encrypt(value: string) {
      if (!keyBytes) return undefined;
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, keyBytes, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    decrypt(value: string) {
      if (!keyBytes) return undefined;
      try {
        const [version, ivText, tagText, ciphertextText] = value.split('.');
        if (version !== VERSION || !ivText || !tagText || !ciphertextText) return undefined;
        const iv = Buffer.from(ivText, 'base64url');
        const tag = Buffer.from(tagText, 'base64url');
        const ciphertext = Buffer.from(ciphertextText, 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return undefined;
        const decipher = createDecipheriv(ALGORITHM, keyBytes, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        return undefined;
      }
    }
  };
}

export function generateCredentialKey(): string {
  return randomBytes(32).toString('base64');
}

export function encryptCredential(value: string, key = process.env.MCP_CREDENTIALS_KEY): string | undefined {
  return createCredentialCipher(key).encrypt(value);
}

export function decryptCredential(value: string, key = process.env.MCP_CREDENTIALS_KEY): string | undefined {
  return createCredentialCipher(key).decrypt(value);
}

function decodeKey(key: string | undefined): Buffer | undefined {
  if (!key) return undefined;
  try {
    const bytes = Buffer.from(key, 'base64');
    // Reject accidental base64 strings instead of silently accepting a short key.
    if (bytes.length !== 32 || bytes.toString('base64').replace(/=+$/, '') !== key.replace(/=+$/, '')) {
      return undefined;
    }
    return bytes;
  } catch {
    return undefined;
  }
}
