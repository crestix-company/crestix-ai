import { describe, expect, it } from "vitest";
import { decryptRefreshToken, describeBase64Input, encryptRefreshToken } from "./token-encryption";

const testKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("refresh token encryption", () => {
  it("round-trips with AES-GCM and does not expose plaintext", async () => {
    const encrypted = await encryptRefreshToken("google-refresh-token", testKey, "user-a");
    expect(encrypted).not.toContain("google-refresh-token");
    await expect(decryptRefreshToken(encrypted, testKey, "user-a")).resolves.toBe("google-refresh-token");
  });

  it("binds ciphertext to the user id", async () => {
    const encrypted = await encryptRefreshToken("google-refresh-token", testKey, "user-a");
    await expect(decryptRefreshToken(encrypted, testKey, "user-b")).rejects.toThrow();
  });

  it("accepts a standard Base64 encoding of exactly 32 AES key bytes", async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(255)));
    const encrypted = await encryptRefreshToken("opaque-token", key, "user-a");
    await expect(decryptRefreshToken(encrypted, key, "user-a")).resolves.toBe("opaque-token");
    expect(describeBase64Input(key).decoded_byte_length).toBe(32);
  });

  it("accepts the same key in unpadded Base64URL without changing stored v1 ciphertext", async () => {
    const standard = btoa(String.fromCharCode(...new Uint8Array(32).fill(255)));
    const url = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const encrypted = await encryptRefreshToken("opaque-token", url, "user-a");
    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/);
    await expect(decryptRefreshToken(encrypted, standard, "user-a")).resolves.toBe("opaque-token");
    expect(describeBase64Input(url)).toMatchObject({ base64url_charset: true, decoded_byte_length: 32 });
  });

  it("treats a Google refresh token as opaque UTF-8 text, not Base64", async () => {
    const token = "1//opaque:token?%&=日本語";
    const encrypted = await encryptRefreshToken(token, testKey, "user-a");
    await expect(decryptRefreshToken(encrypted, testKey, "user-a")).resolves.toBe(token);
  });

  it("round-trips the legacy v1 IV and ciphertext plus authentication tag", async () => {
    const iv = new Uint8Array(12).fill(7);
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(testKey), (c) => c.charCodeAt(0)),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const ciphertextWithTag = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("user-a") },
      key,
      new TextEncoder().encode("legacy-token"),
    ));
    const legacy = `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...ciphertextWithTag))}`;
    await expect(decryptRefreshToken(legacy, testKey, "user-a")).resolves.toBe("legacy-token");
    const tampered = Uint8Array.from(ciphertextWithTag);
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptRefreshToken(`v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...tampered))}`, testKey, "user-a"))
      .rejects.toThrow();
  });

  it("fails closed on malformed keys and wrong decoded key lengths", async () => {
    for (const key of ["not a base64 key", "abcde", "ab+_", btoa(String.fromCharCode(...new Uint8Array(16)))]) {
      await expect(encryptRefreshToken("opaque-token", key, "user-a")).rejects.toThrow();
    }
  });
});
