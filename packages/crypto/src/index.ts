import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = util;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface EncryptedMessage {
  nonce: string;      // base64
  ciphertext: string; // base64
}

export interface PairingCode {
  sessionId: string;
  publicKey: string;  // base64
  timestamp: number;
}

/**
 * Generate a new X25519 key pair for key exchange
 */
export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

/**
 * Generate a shared secret from our secret key and peer's public key
 * Uses X25519 key exchange
 */
export function computeSharedSecret(
  ourSecretKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  // Use nacl.box.before to compute shared secret
  return nacl.box.before(theirPublicKey, ourSecretKey);
}

/**
 * Encrypt a message using the shared secret (NaCl secretbox - XSalsa20-Poly1305)
 * Note: NaCl uses XSalsa20-Poly1305, which is similar to XChaCha20-Poly1305
 */
export function encrypt(
  message: string | Uint8Array,
  sharedSecret: Uint8Array
): EncryptedMessage {
  const messageBytes = typeof message === 'string'
    ? decodeUTF8(message)
    : message;

  // Generate random nonce (24 bytes for secretbox)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

  // Encrypt
  const ciphertext = nacl.secretbox(messageBytes, nonce, sharedSecret);

  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

/**
 * Decrypt a message using the shared secret
 */
export function decrypt(
  encrypted: EncryptedMessage,
  sharedSecret: Uint8Array
): Uint8Array | null {
  const nonce = decodeBase64(encrypted.nonce);
  const ciphertext = decodeBase64(encrypted.ciphertext);

  const decrypted = nacl.secretbox.open(ciphertext, nonce, sharedSecret);
  return decrypted;
}

/**
 * Decrypt to string
 */
export function decryptToString(
  encrypted: EncryptedMessage,
  sharedSecret: Uint8Array
): string | null {
  const decrypted = decrypt(encrypted, sharedSecret);
  if (!decrypted) return null;
  return encodeUTF8(decrypted);
}

/**
 * Generate a pairing code (for QR code or manual entry)
 */
export function generatePairingCode(
  sessionId: string,
  publicKey: Uint8Array
): PairingCode {
  return {
    sessionId,
    publicKey: encodeBase64(publicKey),
    timestamp: Date.now(),
  };
}

/**
 * Parse a pairing code
 */
export function parsePairingCode(code: string): PairingCode | null {
  try {
    const parsed = JSON.parse(code);
    if (!parsed.sessionId || !parsed.publicKey || !parsed.timestamp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Encode pairing code to string (for QR code)
 */
export function encodePairingCode(code: PairingCode): string {
  return JSON.stringify(code);
}

/**
 * Convert public key from base64 to Uint8Array
 */
export function publicKeyFromBase64(base64: string): Uint8Array {
  return decodeBase64(base64);
}

/**
 * Convert public key to base64
 */
export function publicKeyToBase64(key: Uint8Array): string {
  return encodeBase64(key);
}

// Re-export utilities
export { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 };
