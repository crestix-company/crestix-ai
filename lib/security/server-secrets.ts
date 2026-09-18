import "server-only";
// Read only at request time on the server. Never serialize to a client component.
export function getTokenEncryptionKey(): string {
  const key = process.env["TOKEN_ENCRYPTION_KEY"];

  if (typeof key !== "string" || !key) {
    throw new Error("TOKEN_ENCRYPTION_KEY is missing");
  }
  return key;
}
