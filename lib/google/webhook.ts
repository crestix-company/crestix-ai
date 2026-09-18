import "server-only";

import { createHash } from "node:crypto";

export interface GoogleCalendarWebhookHeaders {
  channelId: string;
  channelToken: string;
  resourceId: string;
  resourceState: string;
  messageNumber: number;
}

export function parseGoogleCalendarWebhookHeaders(headers: Headers): GoogleCalendarWebhookHeaders | null {
  const channelId = headers.get("x-goog-channel-id");
  const channelToken = headers.get("x-goog-channel-token");
  const resourceId = headers.get("x-goog-resource-id");
  const resourceState = headers.get("x-goog-resource-state");
  const messageNumberRaw = headers.get("x-goog-message-number");

  if (!channelId || !channelToken || !resourceId || !resourceState || !messageNumberRaw) return null;
  if (!/^\d+$/.test(messageNumberRaw)) return null;

  const messageNumber = Number(messageNumberRaw);
  if (!Number.isSafeInteger(messageNumber) || messageNumber < 1) return null;

  return { channelId, channelToken, resourceId, resourceState, messageNumber };
}

export function hashCalendarChannelToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
