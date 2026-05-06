/**
 * encryption.js
 * Portility — Web Crypto API encryption/decryption for operating instructions.
 *
 * Uses AES-256-GCM with PBKDF2 key derivation (100,000 iterations).
 * Passphrase never leaves the client.
 */

'use strict';

/**
 * Derive an AES-256-GCM key from a passphrase using PBKDF2.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(passphrase, salt) {
  const encoder = new TextEncoder();
  const passphraseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passphraseKey,
    256
  );

  return crypto.subtle.importKey(
    'raw',
    derivedBits,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt instructions text with a passphrase.
 * Returns base64-encoded encrypted data, salt, and IV.
 * @param {string} instructionsText
 * @param {string} passphrase
 * @returns {Promise<{encrypted: string, salt: string, iv: string}>}
 */
async function encryptInstructions(instructionsText, passphrase) {
  const encoder = new TextEncoder();
  const data = encoder.encode(instructionsText);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(passphrase, salt);

  const encryptedData = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    data
  );

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(encryptedData))),
    salt: btoa(String.fromCharCode(...new Uint8Array(salt))),
    iv: btoa(String.fromCharCode(...new Uint8Array(iv))),
  };
}

/**
 * Decrypt encrypted instructions with a passphrase.
 * @param {{encrypted: string, salt: string, iv: string}} encryptedBlob
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
async function decryptInstructions(encryptedBlob, passphrase) {
  const encryptedData = Uint8Array.from(atob(encryptedBlob.encrypted), function (c) { return c.charCodeAt(0); });
  const salt = Uint8Array.from(atob(encryptedBlob.salt), function (c) { return c.charCodeAt(0); });
  const iv = Uint8Array.from(atob(encryptedBlob.iv), function (c) { return c.charCodeAt(0); });

  const key = await deriveKey(passphrase, salt);

  try {
    const decryptedData = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encryptedData
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedData);
  } catch (error) {
    throw new Error('Incorrect passphrase or corrupted data');
  }
}
