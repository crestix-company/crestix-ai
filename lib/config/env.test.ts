import { describe, expect, it } from "vitest";
import { validatePublicEnv } from "./env";

describe("validatePublicEnv", () => {
  it("fails closed when environment variables are absent", () => {
    expect(validatePublicEnv({}).success).toBe(false);
  });

  it("accepts publishable browser configuration", () => {
    expect(validatePublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_example",
    }).success).toBe(true);
  });
});
