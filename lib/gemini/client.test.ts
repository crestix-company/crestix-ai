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
