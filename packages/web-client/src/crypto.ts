import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = util;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface EncryptedMessage {
  nonce: string;
  ciphertext: string;
}

export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

export function computeSharedSecret(
  ourSecretKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  return nacl.box.before(theirPublicKey, ourSecretKey);
}

export function encrypt(
  message: string | Uint8Array,
  sharedSecret: Uint8Array
): EncryptedMessage {
  const messageBytes = typeof message === 'string'
    ? decodeUTF8(message)
    : message;

  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(messageBytes, nonce, sharedSecret);

  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

export function decrypt(
  encrypted: EncryptedMessage,
  sharedSecret: Uint8Array
): Uint8Array | null {
  const nonce = decodeBase64(encrypted.nonce);
  const ciphertext = decodeBase64(encrypted.ciphertext);

  return nacl.secretbox.open(ciphertext, nonce, sharedSecret);
}

export function decryptToString(
  encrypted: EncryptedMessage,
  sharedSecret: Uint8Array
): string | null {
  const decrypted = decrypt(encrypted, sharedSecret);
  if (!decrypted) return null;
  return encodeUTF8(decrypted);
}

export function publicKeyFromBase64(base64: string): Uint8Array {
  return decodeBase64(base64);
}

export function publicKeyToBase64(key: Uint8Array): string {
  return encodeBase64(key);
}

export { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 };
