import { NextResponse } from "next/server";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { getGeminiCredentials } from "@/lib/security/server-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEMPORARY diagnostic endpoint - to be deleted once the live model
 * availability for this Production GEMINI_API_KEY is confirmed
 * (gemini-2.5-flash and gemini-2.5-flash-lite were both found to return
 * 404 "no longer available to new users" for this account/key). Admin-only
 * (existing session auth, not the internal CRON_SECRET pattern, since this
 * is meant to be opened directly in an authenticated browser). Never
 * returns the API key, a credential, or a token - only model names,
 * supported generation methods, and smoke-test pass/fail outcomes.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
  supportedActions?: string[];
}

interface GeminiModelsListResponse {
  models?: GeminiModelInfo[];
  nextPageToken?: string;
}

interface ModelSummary {
  name: string;
  supportsGenerateContent: boolean;
  methods: string[];
}

interface SmokeTestResult {
  model: string;
  ok: boolean;
  status?: number;
  classification?: "billing_required" | "tool_not_available" | "quota" | "not_found" | "other";
  safeMessage?: string;
}

function classify(status: number, bodyText: string): SmokeTestResult["classification"] {
  const lower = bodyText.toLowerCase();
  if (status === 404) return "not_found";
  if (status === 429) return "quota";
  if (lower.includes("billing")) return "billing_required";
  if (lower.includes("grounding") || lower.includes("tool") || lower.includes("not supported") || lower.includes("not available")) {
    return "tool_not_available";
  }
  return "other";
}

async function listAllModels(apiKey: string): Promise<ModelSummary[]> {
  const models: ModelSummary[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GEMINI_BASE}/models`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url.toString(), {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`models_list_failed_${response.status}`);

    const data = await response.json() as GeminiModelsListResponse;
    for (const model of data.models ?? []) {
      const methods = model.supportedGenerationMethods ?? model.supportedActions ?? [];
      models.push({
        name: model.name ?? "unknown",
        methods,
        supportsGenerateContent: methods.includes("generateContent"),
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return models;
}

async function smokeTestGenerate(apiKey: string, model: string, withGrounding: boolean): Promise<SmokeTestResult> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
  };
  if (withGrounding) body.tools = [{ google_search: {} }];
  else body.generationConfig = { responseMimeType: "text/plain" };

  const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.ok) return { model, ok: true, status: response.status };

  const text = await response.text().catch(() => "");
  return {
    model,
    ok: false,
    status: response.status,
    classification: classify(response.status, text),
    safeMessage: text.slice(0, 400),
  };
}

export async function GET() {
  const user = await requireAuthorizedUser();
  if (user.role !== "ADMIN") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const { apiKey } = getGeminiCredentials("generation");

  let models: ModelSummary[];
  try {
    models = await listAllModels(apiKey);
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "models_list_failed",
      code: error instanceof Error ? error.message : "unknown",
    }, { status: 502 });
  }

  const generateContentModels = models
    .filter((m) => m.supportsGenerateContent)
    .map((m) => ({ name: m.name, methods: m.methods }));

  const candidateNames = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];
  const presentCandidates = candidateNames.filter((c) =>
    generateContentModels.some((m) => m.name === `models/${c}` || m.name === c));

  const generationSmokeTest = presentCandidates.includes("gemini-3.8-flash")
    ? await smokeTestGenerate(apiKey, "gemini-3.8-flash", false)
    : null;

  const groundingSmokeTest = presentCandidates.includes("gemini-2.5-flash-lite")
    ? await smokeTestGenerate(apiKey, "gemini-2.5-flash-lite", true)
    : null;

  return NextResponse.json({
    ok: true,
    generateContentModelCount: generateContentModels.length,
    generateContentModels,
    candidateAvailability: candidateNames.map((c) => ({
      name: c,
      present: presentCandidates.includes(c),
    })),
    generationSmokeTest,
    groundingSmokeTest,
  });
}
