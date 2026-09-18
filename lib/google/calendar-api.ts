import "server-only";

import { getGoogleOAuthCredentials } from "@/lib/security/server-secrets";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 15_000;

export class GoogleCalendarApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`Google Calendar API operation failed: ${operation} (${status})`);
    this.name = "GoogleCalendarApiError";
  }
}

export interface GoogleCalendarEvent {
  id: string;
  iCalUID?: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  updated?: string;
  eventType?: string;
  recurringEventId?: string;
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  organizer?: { email?: string };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
  };
}

export interface GoogleCalendarEventsPage {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface GoogleWatchResponse {
  id: string;
  resourceId: string;
  resourceUri?: string;
  expiration?: string | number;
}

async function googleFetch<T>(operation: string, url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new GoogleCalendarApiError(operation, response.status);
  return await response.json() as T;
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getGoogleOAuthCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const payload = await googleFetch<{ access_token?: string }>("refresh_access_token", GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!payload.access_token) throw new GoogleCalendarApiError("refresh_access_token_missing", 502);
  return payload.access_token;
}

export async function listCalendarEventsPage(input: {
  accessToken: string;
  calendarId: string;
  syncToken?: string | null;
  pageToken?: string | null;
  initialTimeMin?: string | null;
}): Promise<GoogleCalendarEventsPage> {
  const url = new URL(
    `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events`,
  );
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("maxResults", "250");
  url.searchParams.append("eventTypes", "default");

  if (input.syncToken) {
    url.searchParams.set("syncToken", input.syncToken);
  } else if (input.initialTimeMin) {
    url.searchParams.set("timeMin", input.initialTimeMin);
  }
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);

  return googleFetch<GoogleCalendarEventsPage>("events_list", url.toString(), {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
}

export async function watchCalendarEvents(input: {
  accessToken: string;
  calendarId: string;
  channelId: string;
  channelToken: string;
  webhookUrl: string;
}): Promise<GoogleWatchResponse> {
  const url = new URL(
    `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events/watch`,
  );
  url.searchParams.append("eventTypes", "default");

  return googleFetch<GoogleWatchResponse>("events_watch", url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: input.channelId,
      type: "web_hook",
      address: input.webhookUrl,
      token: input.channelToken,
      params: { ttl: "604800" },
    }),
  });
}

export async function stopCalendarWatch(input: {
  accessToken: string;
  channelId: string;
  resourceId: string;
}): Promise<void> {
  const response = await fetch(`${GOOGLE_CALENDAR_BASE}/channels/stop`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: input.channelId,
      resourceId: input.resourceId,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok && response.status !== 404) {
    throw new GoogleCalendarApiError("channels_stop", response.status);
  }
}
