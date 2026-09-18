import { describe, expect, it } from "vitest";
import { hashCalendarChannelToken, parseGoogleCalendarWebhookHeaders } from "./webhook";

describe("Google Calendar webhook headers", () => {
  it("parses a valid Google Calendar notification", () => {
    const headers = new Headers({
      "x-goog-channel-id": "channel-a",
      "x-goog-channel-token": "opaque-secret",
      "x-goog-resource-id": "resource-a",
      "x-goog-resource-state": "exists",
      "x-goog-message-number": "42",
    });
    expect(parseGoogleCalendarWebhookHeaders(headers)).toEqual({
      channelId: "channel-a",
      channelToken: "opaque-secret",
      resourceId: "resource-a",
      resourceState: "exists",
      messageNumber: 42,
    });
  });

  it("rejects malformed message numbers", () => {
    const headers = new Headers({
      "x-goog-channel-id": "channel-a",
      "x-goog-channel-token": "opaque-secret",
      "x-goog-resource-id": "resource-a",
      "x-goog-resource-state": "exists",
      "x-goog-message-number": "1.5",
    });
    expect(parseGoogleCalendarWebhookHeaders(headers)).toBeNull();
  });

  it("hashes channel tokens without exposing them", () => {
    expect(hashCalendarChannelToken("opaque-secret")).toMatch(/^[0-9a-f]{64}$/);
  });
});
