/**
 * Structured parsing of the IS (inside sales) handoff notes embedded in a
 * Medical FS Calendar event's description, e.g.:
 *
 *   ISアポ取得者：前田
 *   FS担当者：前川
 *   メールアドレス：...
 *   医院電話番号：...
 *   お名前：後藤 直樹
 *   役職：院長
 *   有償認識：有り
 *   受け入れ：可能
 *   ...
 *
 * `parseIsHandoff` extracts every known field into RawIsHandoff (stored
 * as-is in meetings.is_handoff for the FS's own in-app reference - see the
 * "IS引継ぎ" section of /fs/meetings/[id]). `sanitizeIsHandoff` then
 * projects that down to SanitizedIsHandoff, an explicit allowlist of only
 * the fields needed for sales judgment - this is the ONLY IS-handoff data
 * ever passed into a Gemini prompt. Contact name, the internal CRESTIX
 * staff names (ISアポ取得者/FS担当者), the contact's email, and the
 * clinic's phone number are parsed (for internal display) but never
 * included in SanitizedIsHandoff, matching the raw Calendar description
 * never being sent to an external AI wholesale.
 */

export interface RawIsHandoff {
  appointment_setter: string | null;
  fs_owner: string | null;
  contact_email: string | null;
  clinic_phone: string | null;
  contact_name: string | null;
  contact_role: string | null;
  paid_awareness: string | null;
  patient_acceptance: string | null;
  personality_note: string | null;
  article_status: string | null;
  article_url: string | null;
  concern_exists: string | null;
  concern_detail: string | null;
  growth_area: string | null;
  new_patient_capacity: string | null;
  prior_outcome: string | null;
  prior_outcome_detail: string | null;
  focus_department: string | null;
  homepage_url: string | null;
  notes: string | null;
}

export interface SanitizedIsHandoff {
  contact_role: string | null;
  paid_awareness: string | null;
  patient_acceptance: string | null;
  personality_note: string | null;
  article_status: string | null;
  concern_exists: string | null;
  concern_detail: string | null;
  growth_area: string | null;
  new_patient_capacity: string | null;
  prior_outcome: string | null;
  prior_outcome_detail: string | null;
  focus_department: string | null;
  homepage_url: string | null;
  notes: string | null;
}

const LABEL_TO_FIELD: Record<string, keyof RawIsHandoff> = {
  "ISアポ取得者": "appointment_setter",
  "FS担当者": "fs_owner",
  "メールアドレス": "contact_email",
  "医院電話番号": "clinic_phone",
  "お名前": "contact_name",
  "役職": "contact_role",
  "有償認識": "paid_awareness",
  "受け入れ": "patient_acceptance",
  "人柄の印象": "personality_note",
  "記事名": "article_status",
  "マイナビURL": "article_url",
  "懸念点": "concern_exists",
  "懸念点（詳細）": "concern_detail",
  "伸ばしていきたい領域": "growth_area",
  "新規患者の受け入れ": "new_patient_capacity",
  "トーク内容": "prior_outcome",
  "トーク内容（詳細）": "prior_outcome_detail",
  "注力科目": "focus_department",
  "HP URL": "homepage_url",
  "その他備考": "notes",
};

// Longest-label-first so "懸念点（詳細）" is tried before the shorter
// "懸念点" when matching the text before a colon.
const KNOWN_LABELS = Object.keys(LABEL_TO_FIELD).sort((a, b) => b.length - a.length);

const GOOGLE_MEET_NOISE_PATTERN = /meet\.google\.com|Join by phone|電話でも参加|^PIN[：:]|^-::~:~::/;

function splitLabelAndValue(line: string): { label: string; value: string } | null {
  const separatorIndex = line.search(/[：:]/);
  if (separatorIndex === -1) return null;
  const label = line.slice(0, separatorIndex).trim();
  if (!KNOWN_LABELS.includes(label)) return null;
  return { label, value: line.slice(separatorIndex + 1).trim() };
}

function emptyRawIsHandoff(): RawIsHandoff {
  return {
    appointment_setter: null,
    fs_owner: null,
    contact_email: null,
    clinic_phone: null,
    contact_name: null,
    contact_role: null,
    paid_awareness: null,
    patient_acceptance: null,
    personality_note: null,
    article_status: null,
    article_url: null,
    concern_exists: null,
    concern_detail: null,
    growth_area: null,
    new_patient_capacity: null,
    prior_outcome: null,
    prior_outcome_detail: null,
    focus_department: null,
    homepage_url: null,
    notes: null,
  };
}

/**
 * Order-independent: recognizes each line by its exact label text (not
 * position), so a differently-ordered or partially-filled IS handoff
 * template still parses correctly. A line that isn't a recognized
 * "label：value" pair is appended (as a new line) to whichever known field
 * was most recently opened, supporting multi-line values like
 * 懸念点（詳細）without needing an explicit end marker. Returns null if the
 * description contains no recognizable IS handoff fields at all (a normal
 * Calendar description with no IS template).
 */
export function parseIsHandoff(description: string | null | undefined): RawIsHandoff | null {
  if (!description) return null;

  const fields = emptyRawIsHandoff();
  let currentKey: keyof RawIsHandoff | null = null;
  let matchedAny = false;

  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (GOOGLE_MEET_NOISE_PATTERN.test(line)) continue;

    const parsed = splitLabelAndValue(line);
    if (parsed) {
      matchedAny = true;
      currentKey = LABEL_TO_FIELD[parsed.label];
      fields[currentKey] = parsed.value || null;
      continue;
    }

    if (currentKey) {
      const existing = fields[currentKey];
      fields[currentKey] = existing ? `${existing}\n${line}` : line;
    }
  }

  return matchedAny ? fields : null;
}

/**
 * The only IS-handoff projection ever passed into a Gemini prompt - an
 * explicit allowlist (not a blocklist), so a future field added to
 * RawIsHandoff is safe-by-default (excluded) unless deliberately added
 * here too.
 */
export function sanitizeIsHandoff(raw: RawIsHandoff): SanitizedIsHandoff {
  return {
    contact_role: raw.contact_role,
    paid_awareness: raw.paid_awareness,
    patient_acceptance: raw.patient_acceptance,
    personality_note: raw.personality_note,
    article_status: raw.article_status,
    concern_exists: raw.concern_exists,
    concern_detail: raw.concern_detail,
    growth_area: raw.growth_area,
    new_patient_capacity: raw.new_patient_capacity,
    prior_outcome: raw.prior_outcome,
    prior_outcome_detail: raw.prior_outcome_detail,
    focus_department: raw.focus_department,
    homepage_url: raw.homepage_url,
    notes: raw.notes,
  };
}
