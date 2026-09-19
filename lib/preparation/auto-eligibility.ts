export const FS_AUTO_PREPARATION_FEATURE_KEY = "FS_AUTO_PREPARATION";

export interface AutoPreparationFlag {
  enabled: boolean;
  automation_start_at: string | null;
}

export interface EligibilityInput {
  meetingType: string;
  meetingStatus: string;
  scheduledStartAt: string | null;
  flag: AutoPreparationFlag | null;
}

/**
 * Pure decision only - no DB/network access - so it can be unit tested
 * directly against the acceptance table in the auto-preparation spec.
 */
export function isEligibleForAutoPreparation(input: EligibilityInput): boolean {
  if (!input.flag?.enabled) return false;
  if (input.meetingType !== "E1") return false;
  if (input.meetingStatus === "CANCELLED") return false;
  if (!input.scheduledStartAt || !input.flag.automation_start_at) return false;

  return new Date(input.scheduledStartAt).getTime() >= new Date(input.flag.automation_start_at).getTime();
}
