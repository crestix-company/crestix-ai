export type FsMeetingType = "E1" | "E2" | "HD" | "OTHER";

export interface FsMeetingDetection {
  meetingType: FsMeetingType;
  ruleId: string;
  cancelled: boolean;
}

type Rule = {
  id: string;
  meetingType: FsMeetingType;
  matches: (title: string) => boolean;
};

/**
 * Medical FS MVP scope only: 【お打ち合わせ①】/【お打ち合わせ②】 are the sole
 * source of truth for newly-detected meetings. Legacy E1/E2 markers, HD
 * (飲食/美容 etc.) meetings, and the generic 【商談】 marker are intentionally
 * NOT matched here anymore - they fall through to `null` (no meeting
 * created/updated for that Calendar event). Existing HD/OTHER/legacy-marker
 * `meetings` rows created by an earlier ruleset are left untouched in the DB
 * (kept for audit/history) but the Medical FS UI and auto-preparation never
 * query for anything outside E1/E2.
 *
 * The generic bare word "商談" was never enabled even before this change -
 * real CRESTIX Calendar samples include internal tasks such as "商談動画..."
 * that are not customer meetings.
 */
const RULES: readonly Rule[] = [
  { id: "medical-current-e1", meetingType: "E1", matches: (title) => title.includes("【お打ち合わせ①】") },
  { id: "medical-current-e2", meetingType: "E2", matches: (title) => title.includes("【お打ち合わせ②】") },
];

const CANCELLED_TITLE_PATTERN = /キャンセル|無効商談/;

export function detectFsMeeting(title: string): FsMeetingDetection | null {
  const normalized = title.trim();
  if (!normalized) return null;

  const rule = RULES.find((candidate) => candidate.matches(normalized));
  if (!rule) return null;

  return {
    meetingType: rule.meetingType,
    ruleId: rule.id,
    cancelled: CANCELLED_TITLE_PATTERN.test(normalized),
  };
}
