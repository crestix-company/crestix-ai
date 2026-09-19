import { describe, expect, it } from "vitest";
import { isEligibleForAutoPreparation } from "./auto-eligibility";

const enabledFlag = { enabled: true, automation_start_at: "2026-09-19T00:00:00.000Z" };

describe("isEligibleForAutoPreparation", () => {
  it("E1 + today or later + enabled -> true", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E1",
      meetingStatus: "DETECTED",
      scheduledStartAt: "2026-09-20T01:00:00.000Z",
      flag: enabledFlag,
    })).toBe(true);
  });

  it("E1 exactly at automation_start_at -> true (inclusive boundary)", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E1",
      meetingStatus: "DETECTED",
      scheduledStartAt: enabledFlag.automation_start_at,
      flag: enabledFlag,
    })).toBe(true);
  });

  it("E1 scheduled before automation_start_at -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E1",
      meetingStatus: "DETECTED",
      scheduledStartAt: "2026-09-01T00:00:00.000Z",
      flag: enabledFlag,
    })).toBe(false);
  });

  it("E2 -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E2",
      meetingStatus: "DETECTED",
      scheduledStartAt: "2026-09-20T01:00:00.000Z",
      flag: enabledFlag,
    })).toBe(false);
  });

  it("HD -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "HD",
      meetingStatus: "DETECTED",
      scheduledStartAt: "2026-09-20T01:00:00.000Z",
      flag: enabledFlag,
    })).toBe(false);
  });

  it("OTHER -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "OTHER",
      meetingStatus: "DETECTED",
      scheduledStartAt: "2026-09-20T01:00:00.000Z",
      flag: enabledFlag,
    })).toBe(false);
  });

  it("CANCELLED -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E1",
      meetingStatus: "CANCELLED",
      scheduledStartAt: "2026-09-20T01:00:00.000Z",
      flag: enabledFlag,
    })).toBe(false);
  });

  it("feature flag disabled -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E1",
      meetingStatus: "DETECTED",
      scheduledStartAt: "2026-09-20T01:00:00.000Z",
      flag: { enabled: false, automation_start_at: "2026-09-19T00:00:00.000Z" },
    })).toBe(false);
  });

  it("no flag row for the user -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E1",
      meetingStatus: "DETECTED",
      scheduledStartAt: "2026-09-20T01:00:00.000Z",
      flag: null,
    })).toBe(false);
  });

  it("missing scheduled_start_at -> false", () => {
    expect(isEligibleForAutoPreparation({
      meetingType: "E1",
      meetingStatus: "DETECTED",
      scheduledStartAt: null,
      flag: enabledFlag,
    })).toBe(false);
  });
});
