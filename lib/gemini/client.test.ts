import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateStructuredJson, researchClinic } from "./client";

vi.mock("@/lib/security/server-secrets", () => ({
  getGeminiCredentials: () => ({ apiKey: "test-key", model: "gemini-2.5-flash" }),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("researchClinic", () => {
  it("requests Google Search grounding and extracts sources without leaking the API key into the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: "調査結果の本文" }] },
          groundingMetadata: {
            webSearchQueries: ["テストクリニック"],
            groundingChunks: [
              { web: { uri: "https://example.com/clinic", title: "公式サイト" } },
              { web: { uri: "https://example.com/no-title" } },
            ],
          },
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      }),
    });
    global.fetch = fetchMock as never;

    const result = await researchClinic("調査してください");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.generationConfig).toBeUndefined();

    expect(result.summary).toBe("調査結果の本文");
    expect(result.sources).toEqual([
      { url: "https://example.com/clinic", title: "公式サイト" },
      { url: "https://example.com/no-title", title: undefined },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("throws GeminiApiError on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as never;
    await expect(researchClinic("x")).rejects.toThrow("Gemini API operation failed");
  });

  it("captures Google's error response body in the thrown error, so a config problem (wrong model/API version) is distinguishable from a transient failure without needing to guess at secret values", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "{\"error\":{\"code\":404,\"message\":\"models/bad-model is not found for API version v1beta\",\"status\":\"NOT_FOUND\"}}",
    }) as never;

    await expect(researchClinic("x")).rejects.toThrow(/models\/bad-model is not found/);
  });

  it("does not throw when the error response has no readable body (e.g. a mocked/malformed response)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as never;
    await expect(researchClinic("x")).rejects.toThrow("Gemini API operation failed: generate_content (500)");
  });
});

describe("generateStructuredJson", () => {
  it("requests JSON response mode without the search tool", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      }),
    });
    global.fetch = fetchMock as never;

    const result = await generateStructuredJson("JSON前提のプロンプト");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json" });
    expect(body.tools).toBeUndefined();
    expect(result.rawText).toBe("{\"ok\":true}");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });
});
