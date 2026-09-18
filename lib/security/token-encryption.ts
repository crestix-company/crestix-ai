const standardBase64 = /^[A-Za-z0-9+/]+={0,2}$/;
const urlBase64 = /^[A-Za-z0-9_-]+={0,2}$/;

export function describeBase64Input(value: string) {
  const standard = standardBase64.test(value);
  const url = urlBase64.test(value);
  let decodedByteLength: number | null = null;
  if (standard || url) {
    try {
      decodedByteLength = decodeBase64(value, "diagnostic").byteLength;
    } catch {
      // The diagnostic must never include or echo the input value.
    }
  }
  return {
    length: value.length,
    length_mod_4: value.length % 4,
    standard_base64_charset: standard,
    base64url_charset: url,
    decoded_byte_length: decodedByteLength,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string, label: string): Uint8Array<ArrayBuffer> {
  if (!standardBase64.test(value) && !urlBase64.test(value)) {
    throw new Error(`${label} must be standard Base64 or Base64URL`);
  }
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1 || (value.includes("=") && value.length % 4 !== 0)) {
    throw new Error(`${label} has invalid Base64 padding`);
  }
  const normalized = unpadded.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - unpadded.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error(`${label} is not valid Base64`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64(bytes).replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error(`${label} is not canonical Base64`);
  }
  return bytes;
}

function decodeAes256Key(encodedKey: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(encodedKey, "TOKEN_ENCRYPTION_KEY");
  if (bytes.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return bytes;
}

async function importKey(encodedKey: string) {
  return crypto.subtle.importKey("raw", decodeAes256Key(encodedKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptRefreshToken(token: string, encodedKey: string, userId: string): Promise<string> {
  if (!token) throw new Error("Google provider refresh token is required");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(encodedKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    key,
    new TextEncoder().encode(token),
  );
  // Keep the existing v1 format: standard Base64 IV and ciphertext+GCM tag.
  return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptRefreshToken(value: string, encodedKey: string, userId: string): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new Error("Unsupported encrypted token format");
  }
  const iv = decodeBase64(parts[1], "encrypted token IV");
  const ciphertext = decodeBase64(parts[2], "encrypted token ciphertext and tag");
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error("Invalid encrypted token length");
  const key = await importKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
