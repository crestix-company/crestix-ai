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
 * Rules are deliberately deterministic. The generic bare word "商談" is not
 * enabled because real CRESTIX Calendar samples include internal tasks such as
 * "商談動画..." that are not customer meetings.
 */
const RULES: readonly Rule[] = [
  { id: "medical-current-e1", meetingType: "E1", matches: (title) => title.includes("【お打ち合わせ①】") },
  { id: "medical-current-e2", meetingType: "E2", matches: (title) => title.includes("【お打ち合わせ②】") },
  { id: "legacy-e1", meetingType: "E1", matches: (title) => title.includes("【E1】") },
  { id: "legacy-e2", meetingType: "E2", matches: (title) => title.includes("【E2】") },
  { id: "legacy-hd", meetingType: "HD", matches: (title) => /【HD[^】]*】/.test(title) },
  { id: "explicit-meeting", meetingType: "OTHER", matches: (title) => title.includes("【商談】") },
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
