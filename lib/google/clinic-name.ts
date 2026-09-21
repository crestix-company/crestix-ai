const MARKER_PATTERN = /【お打ち合わせ[①②]】/g;
/**
 * Operational prefixes glued onto the title by whoever reschedules/cancels
 * the Calendar event (e.g. "リスケ【お打ち合わせ①】渋谷胃腸クリニック 様").
 * Not part of the spec's literal removal list (which only calls out the
 * marker itself and trailing 様), but leaving them attached would defeat
 * the point of clinic_name being a clean display/search name.
 */
const KNOWN_OPERATIONAL_PREFIX_PATTERN = /^(リスケ|キャンセル)+/;
const TRAILING_HONORIFIC_PATTERN = /\s*様\s*$/;

/**
 * Normalizes a Medical FS Calendar title into a clean clinic display name,
 * e.g. "【お打ち合わせ①】渋谷胃腸クリニック 様" -> "渋谷胃腸クリニック".
 * Used as the primary display name across the Medical FS UI and as the
 * subject of Research Agent queries. Returns an empty string if nothing
 * meaningful remains after stripping markers/prefixes/honorific.
 */
export function extractClinicName(title: string): string {
  let normalized = title.replace(MARKER_PATTERN, "").trim();
  normalized = normalized.replace(KNOWN_OPERATIONAL_PREFIX_PATTERN, "").trim();
  normalized = normalized.replace(TRAILING_HONORIFIC_PATTERN, "").trim();
  return normalized;
}
