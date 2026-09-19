const FENCED_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (char === "\\") escapeNext = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Pasted ChatGPT answers vary: a fenced ```json block, a bare JSON object, or
 * either wrapped in surrounding prose. Tries the fenced block first, then
 * falls back to scanning for the first balanced top-level {...}.
 */
export function extractJsonObject(rawText: string): unknown | null {
  const candidates: string[] = [];

  const fenced = FENCED_BLOCK_PATTERN.exec(rawText);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const balanced = firstBalancedObject(rawText);
  if (balanced) candidates.push(balanced);

  candidates.push(rawText.trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  return null;
}
