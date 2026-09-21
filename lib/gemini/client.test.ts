import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGeminiCredentials } from "@/lib/security/server-secrets";
import { generateStructuredJson, researchClinic } from "./client";

vi.mock("@/lib/security/server-secrets", () => ({
  getGeminiCredentials: vi.fn((stage: "research" | "generation") => (
    stage === "research"
      ? { apiKey: "test-key", model: "gemini-research-model" }
      : { apiKey: "test-key", model: "gemini-generation-model" }
  )),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("researchClinic", () => {
  it("GROUNDED path: requests Google Search grounding and extracts sources without leaking the API key into the URL", async () => {
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

    const result = await researchClinic({ groundedPrompt: "調査してください", degradedPrompt: "調査なしで書いてください" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("gemini-research-model");
    expect(String(url)).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.contents[0].parts[0].text).toBe("調査してください");
    expect(body.generationConfig).toBeUndefined();

    expect(result.summary).toBe("調査結果の本文");
    expect(result.sources).toEqual([
      { url: "https://example.com/clinic", title: "公式サイト" },
      { url: "https://example.com/no-title", title: undefined },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(result.model).toBe("gemini-research-model");
    expect(result.researchMode).toBe("GROUNDED");
    expect(result.groundingStatus).toBe("SUCCESS");
    expect(result.groundingErrorSafe).toBeUndefined();
  });

  it("DEGRADED fallback: when grounding is unavailable (429 quota), falls back to the generation-stage model without the search tool, using the degraded prompt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "{\"error\":{\"code\":429,\"message\":\"You exceeded your current quota, please check your plan and billing details.\",\"status\":\"RESOURCE_EXHAUSTED\"}}",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Web未確認の事前情報メモ" }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
        }),
      });
    global.fetch = fetchMock as never;

    const result = await researchClinic({ groundedPrompt: "調査してください", degradedPrompt: "調査なしで書いてください" });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [groundedUrl, groundedInit] = fetchMock.mock.calls[0];
    expect(String(groundedUrl)).toContain("gemini-research-model");
    expect(JSON.parse(groundedInit.body as string).tools).toEqual([{ google_search: {} }]);

    const [degradedUrl, degradedInit] = fetchMock.mock.calls[1];
    expect(String(degradedUrl)).toContain("gemini-generation-model");
    const degradedBody = JSON.parse(degradedInit.body as string);
    expect(degradedBody.tools).toBeUndefined();
    expect(degradedBody.contents[0].parts[0].text).toBe("調査なしで書いてください");

    expect(result.summary).toBe("Web未確認の事前情報メモ");
    expect(result.sources).toEqual([]);
    expect(result.searchCallCount).toBe(0);
    expect(result.model).toBe("gemini-generation-model");
    expect(result.researchMode).toBe("DEGRADED");
    expect(result.groundingStatus).toBe("UNAVAILABLE");
    expect(result.groundingErrorSafe).toContain("429");
  });

  it("threads the caller-supplied attempts count into the generation-stage credential lookup for the DEGRADED fallback (enables model fallback after repeated failures)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "degraded" }] } }], usageMetadata: {} }),
      });
    global.fetch = fetchMock as never;

    await researchClinic({ groundedPrompt: "g", degradedPrompt: "d", attempts: 4 });

    expect(getGeminiCredentials).toHaveBeenCalledWith("generation", { attempts: 4 });
  });

  it("classifies an unexpected (non-quota/config) grounding failure as FAILED rather than UNAVAILABLE, while still degrading gracefully", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "internal error" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "degraded text" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      });
    global.fetch = fetchMock as never;

    const result = await researchClinic({ groundedPrompt: "g", degradedPrompt: "d" });

    expect(result.researchMode).toBe("DEGRADED");
    expect(result.groundingStatus).toBe("FAILED");
  });

  it("rejects when both the grounded attempt and the degraded fallback fail", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }) as never;
    await expect(researchClinic({ groundedPrompt: "g", degradedPrompt: "d" })).rejects.toThrow("Gemini API operation failed");
  });

  it("captures Google's error response body in the thrown error, so a config problem (wrong model/API version) is distinguishable from a transient failure without needing to guess at secret values", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "{\"error\":{\"code\":404,\"message\":\"models/bad-model is not found for API version v1beta\",\"status\":\"NOT_FOUND\"}}",
    }) as never;

    await expect(researchClinic({ groundedPrompt: "g", degradedPrompt: "d" })).rejects.toThrow(/models\/bad-model is not found/);
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

  it("threads the caller-supplied attempts count into the generation-stage credential lookup", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: {} }),
    }) as never;

    await generateStructuredJson("prompt", { attempts: 6 });

    expect(getGeminiCredentials).toHaveBeenCalledWith("generation", { attempts: 6 });
  });
});
