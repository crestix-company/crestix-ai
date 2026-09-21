import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidInternalBearerToken, isValidSupabaseCronBridgeToken } from "./internal-auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isValidInternalBearerToken", () => {
  it("accepts the exact CRON_SECRET as a bearer token", () => {
    vi.stubEnv("CRON_SECRET", "correct-secret");
    expect(isValidInternalBearerToken("Bearer correct-secret")).toBe(true);
  });

  it("rejects a wrong token, a missing header, and a missing CRON_SECRET", () => {
    vi.stubEnv("CRON_SECRET", "correct-secret");
    expect(isValidInternalBearerToken("Bearer wrong-secret")).toBe(false);
    expect(isValidInternalBearerToken(null)).toBe(false);

    vi.stubEnv("CRON_SECRET", "");
    expect(isValidInternalBearerToken("Bearer correct-secret")).toBe(false);
  });

  it("never matches a SUPABASE_CRON_BRIDGE_SECRET-shaped token - the two secrets are independent", () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("SUPABASE_CRON_BRIDGE_SECRET", "bridge-secret");
    expect(isValidInternalBearerToken("Bearer bridge-secret")).toBe(false);
  });
});

describe("isValidSupabaseCronBridgeToken", () => {
  it("accepts the exact SUPABASE_CRON_BRIDGE_SECRET as a bearer token", () => {
    vi.stubEnv("SUPABASE_CRON_BRIDGE_SECRET", "correct-bridge-secret");
    expect(isValidSupabaseCronBridgeToken("Bearer correct-bridge-secret")).toBe(true);
  });

  it("rejects a wrong token, a missing header, and a missing secret", () => {
    vi.stubEnv("SUPABASE_CRON_BRIDGE_SECRET", "correct-bridge-secret");
    expect(isValidSupabaseCronBridgeToken("Bearer wrong")).toBe(false);
    expect(isValidSupabaseCronBridgeToken(null)).toBe(false);

    vi.stubEnv("SUPABASE_CRON_BRIDGE_SECRET", "");
    expect(isValidSupabaseCronBridgeToken("Bearer correct-bridge-secret")).toBe(false);
  });

  it("never matches a CRON_SECRET-shaped token - the two secrets are independent", () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("SUPABASE_CRON_BRIDGE_SECRET", "bridge-secret");
    expect(isValidSupabaseCronBridgeToken("Bearer cron-secret")).toBe(false);
  });
});
