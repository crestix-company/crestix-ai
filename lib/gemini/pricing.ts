import "server-only";

/**
 * Cost estimation is opt-in and config-driven, never hardcoded: Gemini
 * pricing (especially Search grounding) changes over time and varies by
 * tier, so baking a number into this module would silently go stale and
 * misreport cost. Without these env vars set, estimateCostUsd returns null
 * rather than a guessed figure presented as fact - "unknown" must stay
 * NULL, never 0.
 */
export interface GeminiPricingConfig {
  inputPerMillionTokensUsd: number | null;
  outputPerMillionTokensUsd: number | null;
  searchPerCallUsd: number | null;
}

function parseOptionalPositiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function loadGeminiPricingConfig(): GeminiPricingConfig {
  return {
    inputPerMillionTokensUsd: parseOptionalPositiveNumber(process.env["GEMINI_PRICE_INPUT_PER_MILLION_TOKENS_USD"]),
    outputPerMillionTokensUsd: parseOptionalPositiveNumber(process.env["GEMINI_PRICE_OUTPUT_PER_MILLION_TOKENS_USD"]),
    searchPerCallUsd: parseOptionalPositiveNumber(process.env["GEMINI_PRICE_SEARCH_PER_CALL_USD"]),
  };
}

export interface UsageForCostEstimate {
  inputTokens: number | null;
  outputTokens: number | null;
  searchCallCount: number | null;
}

/**
 * Returns null whenever pricing isn't configured or usage is unknown -
 * never a fabricated 0 or a guess presented as a confirmed cost.
 */
export function estimateCostUsd(usage: UsageForCostEstimate, pricing: GeminiPricingConfig = loadGeminiPricingConfig()): number | null {
  if (usage.inputTokens == null || usage.outputTokens == null) return null;
  if (pricing.inputPerMillionTokensUsd == null || pricing.outputPerMillionTokensUsd == null) return null;

  let cost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillionTokensUsd
    + (usage.outputTokens / 1_000_000) * pricing.outputPerMillionTokensUsd;

  if (usage.searchCallCount != null && pricing.searchPerCallUsd != null) {
    cost += usage.searchCallCount * pricing.searchPerCallUsd;
  }

  return Math.round(cost * 1_000_000) / 1_000_000;
}
