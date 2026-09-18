import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { createClient } from "@/lib/supabase/server";
import { decryptRefreshToken, encryptRefreshToken } from "@/lib/security/token-encryption";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/security/server-secrets", () => ({
  getTokenEncryptionKey: () => btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
}));
vi.mock("@/lib/auth/app-origin", () => ({
  getAppOrigin: () => "https://crestix-ai.vercel.app",
}));

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const userId = "00000000-0000-0000-0000-000000000001";
const request = () => new NextRequest("https://crestix-ai.vercel.app/auth/callback?code=test-code", {
  headers: { host: "crestix-ai.vercel.app", "x-forwarded-proto": "https" },
});

function setup(refreshToken: string | null, existing: { encrypted_refresh_token: string; token_key_version: number } | null) {
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const exchangeCodeForSession = vi.fn().mockResolvedValue({
    data: { session: {
      user: { id: userId, email: "user@example.com", user_metadata: {} },
      provider_refresh_token: refreshToken,
    } },
    error: null,
  });
  const profileUpsert = vi.fn().mockResolvedValue({ error: null });
  const connectionUpsert = vi.fn().mockResolvedValue({ error: null });
  const lookup = vi.fn().mockResolvedValue({ data: existing, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle: lookup });
  const select = vi.fn().mockReturnValue({ eq });
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      exchangeCodeForSession,
      signOut,
    },
    from: (table: string) => table === "profiles"
      ? { upsert: profileUpsert }
      : { select, upsert: connectionUpsert },
  } as never);
  return { signOut, exchangeCodeForSession, profileUpsert, connectionUpsert, lookup, eq, select };
}

describe("OAuth callback refresh-token persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reuses an existing ciphertext only after decrypting it for the same user", async () => {
    const encrypted = await encryptRefreshToken("opaque-old-token", key, userId);
    const db = setup(null, { encrypted_refresh_token: encrypted, token_key_version: 3 });
    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://crestix-ai.vercel.app/fs/meetings");
    expect(db.eq).toHaveBeenCalledWith("user_id", userId);
    expect(db.connectionUpsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: userId,
      encrypted_refresh_token: encrypted,
      token_key_version: 3,
    }), { onConflict: "user_id" });
    await expect(decryptRefreshToken(encrypted, key, userId)).resolves.toBe("opaque-old-token");
    expect(console.info).toHaveBeenCalledWith("oauth_refresh_token_reused", {
      reason: "provider_refresh_token_missing",
      stored_key_version: 3,
    });
    expect(console.info).toHaveBeenCalledWith("oauth_calendar_connection_ready", {
      used_new_provider_refresh_token: false,
    });
  });

  it("encrypts a new opaque provider token without looking up an old one", async () => {
    const db = setup("1//new:opaque-token", null);
    const response = await GET(request());
    expect(response.headers.get("location")).toBe("https://crestix-ai.vercel.app/fs/meetings");
    expect(db.select).not.toHaveBeenCalled();
    const saved = db.connectionUpsert.mock.calls[0][0];
    expect(saved.encrypted_refresh_token).not.toContain("opaque-token");
    await expect(decryptRefreshToken(saved.encrypted_refresh_token, key, userId))
      .resolves.toBe("1//new:opaque-token");
    expect(console.info).toHaveBeenCalledWith("oauth_calendar_connection_ready", {
      used_new_provider_refresh_token: true,
    });
  });

  it("fails closed when no stored connection exists", async () => {
    const db = setup(null, null);
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("error=calendar_connection_failed");
    expect(db.connectionUpsert).not.toHaveBeenCalled();
    expect(db.signOut).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("oauth_calendar_connection_failed", expect.objectContaining({
      stage: "google_connection_missing",
      has_provider_refresh_token: false,
    }));
  });

  it("fails closed rather than reusing ciphertext encrypted for another user", async () => {
    const encrypted = await encryptRefreshToken("opaque-old-token", key, "another-user");
    const db = setup(null, { encrypted_refresh_token: encrypted, token_key_version: 1 });
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("error=calendar_connection_failed");
    expect(db.connectionUpsert).not.toHaveBeenCalled();
    expect(db.signOut).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("oauth_calendar_connection_failed", expect.objectContaining({
      stage: "stored_refresh_token_decrypt",
    }));
  });

  it("logs only the database error code when connection upsert fails", async () => {
    const db = setup("opaque-new-token", null);
    db.connectionUpsert.mockResolvedValue({ error: { code: "42501", message: "sensitive detail" } });
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("error=calendar_connection_failed");
    expect(console.error).toHaveBeenCalledWith("oauth_calendar_connection_failed", {
      stage: "google_connection_upsert",
      db_error_code: "42501",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("sensitive detail");
  });

  it("logs only the database error code when profile upsert fails", async () => {
    const db = setup("opaque-new-token", null);
    db.profileUpsert.mockResolvedValue({ error: { code: "42501", message: "sensitive detail" } });
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("error=profile_failed");
    expect(db.connectionUpsert).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("oauth_profile_upsert_failed", { db_error_code: "42501" });
  });

  it("fails when email is absent even if a new provider token exists", async () => {
    const db = setup("opaque-new-token", null);
    db.exchangeCodeForSession.mockResolvedValue({
      data: { session: { user: { id: userId, email: null, user_metadata: {} }, provider_refresh_token: "opaque-new-token" } },
      error: null,
    });
    const response = await GET(request());
    expect(response.headers.get("location")).toContain("error=calendar_connection_failed");
    expect(db.connectionUpsert).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("oauth_calendar_connection_failed", {
      stage: "invalid_prerequisites",
      has_email: false,
      has_provider_refresh_token: true,
      key_version_valid: true,
    });
  });

  it("fails when the configured key version is invalid", async () => {
    const previous = process.env.TOKEN_KEY_VERSION;
    process.env.TOKEN_KEY_VERSION = "0";
    try {
      const db = setup("opaque-new-token", null);
      const response = await GET(request());
      expect(response.headers.get("location")).toContain("error=calendar_connection_failed");
      expect(db.connectionUpsert).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith("oauth_calendar_connection_failed", expect.objectContaining({
        stage: "invalid_prerequisites",
        key_version_valid: false,
      }));
    } finally {
      if (previous === undefined) delete process.env.TOKEN_KEY_VERSION;
      else process.env.TOKEN_KEY_VERSION = previous;
    }
  });
});
