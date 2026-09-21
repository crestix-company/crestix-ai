import { afterEach, describe, expect, it, vi } from "vitest";
import { getGeminiCredentials } from "./server-secrets";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getGeminiCredentials", () => {
  it("throws when GEMINI_API_KEY is missing", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => getGeminiCredentials("research")).toThrow("GEMINI_API_KEY is missing");
  });

  it("falls back to hardcoded stage defaults when no model env vars are set (gemini-2.5-flash and gemini-2.5-flash-lite were both retired for new users - these defaults must never silently regress back to either)", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_RESEARCH_MODEL", "");
    vi.stubEnv("GEMINI_GENERATION_MODEL", "");

    expect(getGeminiCredentials("research").model).toBe("gemini-3.5-flash-lite");
    expect(getGeminiCredentials("generation").model).toBe("gemini-3.8-flash");
  });

  it("prefers the stage-specific env var over the legacy GEMINI_MODEL fallback", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "legacy-model");
    vi.stubEnv("GEMINI_RESEARCH_MODEL", "custom-research-model");
    vi.stubEnv("GEMINI_GENERATION_MODEL", "custom-generation-model");

    expect(getGeminiCredentials("research").model).toBe("custom-research-model");
    expect(getGeminiCredentials("generation").model).toBe("custom-generation-model");
  });

  it("falls back to the legacy GEMINI_MODEL when the stage-specific var isn't set", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "legacy-model");
    vi.stubEnv("GEMINI_RESEARCH_MODEL", "");
    vi.stubEnv("GEMINI_GENERATION_MODEL", "");

    expect(getGeminiCredentials("research").model).toBe("legacy-model");
    expect(getGeminiCredentials("generation").model).toBe("legacy-model");
  });
});
