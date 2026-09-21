import "server-only";

import { getGeminiCredentials } from "@/lib/security/server-secrets";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_MS = 55_000;

export class GeminiApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    /**
     * Google's error response body (e.g. "models/x is not found for API
     * version v1beta") - safe to surface: it describes the requested
     * resource/request shape, never echoes the API key (sent only in a
     * request header, never reflected back). Without this, a config
     * problem (wrong model name, wrong API version) was indistinguishable
     * from a transient failure in last_error_safe - just "(404)" with no
     * way to diagnose it without guessing at the actual secret values.
     */
    readonly detail?: string,
  ) {
    super(`Gemini API operation failed: ${operation} (${status})${detail ? ` - ${detail}` : ""}`);
    this.name = "GeminiApiError";
  }

  /**
   * A 404 on generate_content means the requested model doesn't exist or
   * is no longer available (confirmed live: "This model
   * models/gemini-2.5-flash is no longer available to new users") - this
   * is inherently a configuration problem, not a transient failure.
   * Retrying it with exponential backoff just repeats the identical
   * failure until MAX_ATTEMPTS is exhausted, burning the retry budget
   * before ever surfacing that the actual fix is a model name change, not
   * "try again later".
   */
  get isConfigurationError(): boolean {
    return this.status === 404;
  }

  /**
   * Classifies the failure for grounding-fallback and observability
   * purposes, from the status code and Google's own (already-safe, never
   * secret-bearing) error detail text. "not_found"/"quota"/
   * "billing_required"/"tool_not_available" all mean "this capability
   * genuinely isn't available right now" (confirmed live: a 429
   * RESOURCE_EXHAUSTED "check your plan and billing details" on Google
   * Search grounding) - "other" means something unexpected happened that's
   * worth investigating rather than just falling back silently.
   */
  get classification(): "not_found" | "quota" | "billing_required" | "tool_not_available" | "other" {
    const detail = (this.detail ?? "").toLowerCase();
    if (this.status === 404) return "not_found";
    if (this.status === 429) return "quota";
    if (detail.includes("billing")) return "billing_required";
    if (detail.includes("grounding") || detail.includes("tool") || detail.includes("not supported")) return "tool_not_available";
    return "other";
  }
}

interface GeminiPart {
  text?: string;
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  groundingMetadata?: {
    groundingChunks?: GeminiGroundingChunk[];
    webSearchQueries?: string[];
  };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function usageFrom(data: GeminiGenerateContentResponse): GeminiUsage {
  return {
    inputTokens: data.usageMetadata?.promptTokenCount ?? null,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
  };
}

function textFrom(candidate: GeminiCandidate | undefined): string {
  return candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}

async function callGemini(apiKey: string, model: string, body: Record<string, unknown>): Promise<GeminiGenerateContentResponse> {
  const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail: string | undefined;
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = undefined;
    }
    throw new GeminiApiError("generate_content", response.status, detail);
  }
  return await response.json() as GeminiGenerateContentResponse;
}

export type ResearchMode = "GROUNDED" | "DEGRADED";
export type GroundingStatus = "SUCCESS" | "UNAVAILABLE" | "FAILED";

export interface ResearchResult {
  summary: string;
  sources: Array<{ url: string; title?: string }>;
  searchCallCount: number;
  usage: GeminiUsage;
  /** The actual model used for this call - for agent_runs observability. */
  model: string;
  /**
   * GROUNDED: Google Search grounding succeeded, summary/sources reflect
   * real web research. DEGRADED: grounding was unavailable and a plain
   * (ungrounded) generation was used instead - the caller must never treat
   * a DEGRADED summary as verified web research (see buildDegradedResearchPrompt).
   */
  researchMode: ResearchMode;
  groundingStatus: GroundingStatus;
  /** Only set when groundingStatus !== "SUCCESS". */
  groundingErrorSafe?: string;
}

function extractGrounded(data: GeminiGenerateContentResponse): {
  summary: string;
  sources: Array<{ url: string; title?: string }>;
  searchCallCount: number;
} {
  const candidate = data.candidates?.[0];
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((chunk) => chunk.web)
    .filter((web): web is { uri: string; title?: string } => Boolean(web?.uri))
    .map((web) => ({ url: web.uri, title: web.title }));

  return {
    summary: textFrom(candidate),
    sources,
    searchCallCount: candidate?.groundingMetadata?.webSearchQueries?.length ?? (sources.length > 0 ? 1 : 0),
  };
}

/**
 * STEP A (Research Agent). Google Search grounding cannot be combined with
 * responseSchema/JSON mode in the same call, so this step returns free text
 * plus grounding sources; STEP B turns that into the structured preparation.
 *
 * Tries GROUNDED first (research-stage model + Google Search tool). If that
 * fails for ANY reason, falls back to DEGRADED (generation-stage model,
 * gemini-3.8-flash, no search tool, a prompt that explicitly forbids
 * claiming web research was performed - see buildDegradedResearchPrompt).
 * This is intentionally forward-compatible: once grounding becomes
 * available (paid tier, or a future search provider), the GROUNDED path
 * simply starts succeeding again with no code change needed here.
 */
export async function researchClinic(input: { groundedPrompt: string; degradedPrompt: string }): Promise<ResearchResult> {
  const { apiKey: researchApiKey, model: researchModel } = getGeminiCredentials("research");

  try {
    const data = await callGemini(researchApiKey, researchModel, {
      contents: [{ role: "user", parts: [{ text: input.groundedPrompt }] }],
      tools: [{ google_search: {} }],
    });

    return {
      ...extractGrounded(data),
      usage: usageFrom(data),
      model: researchModel,
      researchMode: "GROUNDED",
      groundingStatus: "SUCCESS",
    };
  } catch (error) {
    const classification = error instanceof GeminiApiError ? error.classification : "other";
    const groundingStatus: GroundingStatus = classification === "other" ? "FAILED" : "UNAVAILABLE";
    const groundingErrorSafe = error instanceof Error ? error.message.slice(0, 200) : "unknown_error";

    const { apiKey: fallbackApiKey, model: fallbackModel } = getGeminiCredentials("generation");
    const data = await callGemini(fallbackApiKey, fallbackModel, {
      contents: [{ role: "user", parts: [{ text: input.degradedPrompt }] }],
    });

    return {
      summary: textFrom(data.candidates?.[0]),
      sources: [],
      searchCallCount: 0,
      usage: usageFrom(data),
      model: fallbackModel,
      researchMode: "DEGRADED",
      groundingStatus,
      groundingErrorSafe,
    };
  }
}

export interface StructuredGenerationResult {
  rawText: string;
  usage: GeminiUsage;
  /** The actual model used for this call - for agent_runs observability. */
  model: string;
}

/**
 * JSON-mode call (no search tool). Caller parses/validates rawText. Uses
 * the "generation" stage model (Preparation and Material both use this -
 * neither needs Google Search grounding, so the current GA stable model
 * can be used for output quality rather than the grounding-capable one).
 */
export async function generateStructuredJson(prompt: string): Promise<StructuredGenerationResult> {
  const { apiKey, model } = getGeminiCredentials("generation");
  const data = await callGemini(apiKey, model, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });

  return { rawText: textFrom(data.candidates?.[0]), usage: usageFrom(data), model };
}
