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

async function callGemini(body: Record<string, unknown>): Promise<GeminiGenerateContentResponse> {
  const { apiKey, model } = getGeminiCredentials();
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

export interface ResearchResult {
  summary: string;
  sources: Array<{ url: string; title?: string }>;
  searchCallCount: number;
  usage: GeminiUsage;
}

/**
 * STEP A (Research Agent). Google Search grounding cannot be combined with
 * responseSchema/JSON mode in the same call, so this step returns free text
 * plus grounding sources; STEP B turns that into the structured preparation.
 */
export async function researchClinic(prompt: string): Promise<ResearchResult> {
  const data = await callGemini({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  });

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
    usage: usageFrom(data),
  };
}

export interface StructuredGenerationResult {
  rawText: string;
  usage: GeminiUsage;
}

/** JSON-mode call (no search tool). Caller parses/validates rawText. */
export async function generateStructuredJson(prompt: string): Promise<StructuredGenerationResult> {
  const data = await callGemini({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });

  return { rawText: textFrom(data.candidates?.[0]), usage: usageFrom(data) };
}
