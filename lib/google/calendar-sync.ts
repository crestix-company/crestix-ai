import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptRefreshToken } from "@/lib/security/token-encryption";
import { getTokenEncryptionKey } from "@/lib/security/server-secrets";
import {
  GoogleCalendarApiError,
  listCalendarEventsPage,
  refreshGoogleAccessToken,
  stopCalendarWatch,
  watchCalendarEvents,
  type GoogleCalendarEvent,
} from "@/lib/google/calendar-api";
import { detectFsMeeting } from "@/lib/google/meeting-detection";
import { hashCalendarChannelToken } from "@/lib/google/webhook";

const INITIAL_SYNC_LOOKBACK_DAYS = 30;
const WATCH_RENEW_BEFORE_MS = 48 * 60 * 60 * 1000;
const WATCH_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SYNC_PAGES = 100;

type ConnectionRow = {
  id: string;
  user_id: string;
  calendar_id: string;
  encrypted_refresh_token: string;
  token_key_version: number;
  is_active: boolean;
};

type WatchRow = {
  id: string;
  channel_id: string;
  resource_id: string;
  sync_token: string | null;
  expiration_at: string;
  status: string;
};

type ConnectionContext = {
  connection: ConnectionRow;
  organizationId: string;
};

function safeCalendarErrorCode(error: unknown): string {
  if (error instanceof GoogleCalendarApiError) {
    return `${error.operation}:${error.status}`.slice(0, 160);
  }
  if (error instanceof Error) return error.name.slice(0, 160);
  return "unknown";
}

export { safeCalendarErrorCode };

async function loadConnectionContext(connectionId: string): Promise<ConnectionContext> {
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("google_connections")
    .select("id,user_id,calendar_id,encrypted_refresh_token,token_key_version,is_active")
    .eq("id", connectionId)
    .maybeSingle();

  if (connectionError || !connection || !connection.is_active) {
    throw new Error("calendar_connection_unavailable");
  }

  const { data: membership, error: membershipError } = await admin
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", connection.user_id)
    .eq("department", "FIRST_DIVISION")
    .eq("team", "FS")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membershipError || !membership) throw new Error("calendar_membership_unavailable");

  return {
    connection: connection as ConnectionRow,
    organizationId: membership.organization_id,
  };
}

async function latestActiveWatch(connectionId: string): Promise<WatchRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_watch_channels")
    .select("id,channel_id,resource_id,sync_token,expiration_at,status")
    .eq("google_connection_id", connectionId)
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error("calendar_watch_lookup_failed");
  return data as WatchRow | null;
}

async function accessTokenForConnection(
  connection: ConnectionRow,
  accessTokenOverride?: string,
): Promise<string> {
  if (accessTokenOverride) return accessTokenOverride;

  const refreshToken = await decryptRefreshToken(
    connection.encrypted_refresh_token,
    getTokenEncryptionKey(),
    connection.user_id,
  );
  return refreshGoogleAccessToken(refreshToken);
}

function eventDateTime(value?: { date?: string; dateTime?: string }): string | null {
  if (value?.dateTime) {
    const parsed = new Date(value.dateTime);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  return null;
}

function sanitizeRawPayload(event: GoogleCalendarEvent) {
  return {
    eventType: event.eventType ?? null,
    recurringEventId: event.recurringEventId ?? null,
    originalStartTime: event.originalStartTime ?? null,
    hangoutLink: event.hangoutLink ?? null,
    conferenceEntryPoints: event.conferenceData?.entryPoints?.map((entry) => ({
      entryPointType: entry.entryPointType ?? null,
      uri: entry.uri ?? null,
      label: entry.label ?? null,
    })) ?? [],
  };
}

function normalizeEventStatus(status: GoogleCalendarEvent["status"]): "confirmed" | "tentative" | "cancelled" {
  return status === "cancelled" || status === "tentative" ? status : "confirmed";
}

async function upsertCalendarEventAndMeeting(
  context: ConnectionContext,
  event: GoogleCalendarEvent,
): Promise<void> {
  if (!event.id) return;
  const admin = createAdminClient();

  const { data: existingEvent, error: existingEventError } = await admin
    .from("calendar_events")
    .select("id,title,start_at,end_at")
    .eq("google_connection_id", context.connection.id)
    .eq("google_event_id", event.id)
    .maybeSingle();
  if (existingEventError) throw new Error("calendar_event_lookup_failed");

  const title = event.summary ?? existingEvent?.title ?? "";
  const startAt = eventDateTime(event.start) ?? existingEvent?.start_at ?? null;
  const endAt = eventDateTime(event.end) ?? existingEvent?.end_at ?? null;
  const eventStatus = normalizeEventStatus(event.status);
  const now = new Date().toISOString();

  const { data: storedEvent, error: eventError } = await admin
    .from("calendar_events")
    .upsert({
      google_connection_id: context.connection.id,
      google_event_id: event.id,
      ical_uid: event.iCalUID ?? null,
      etag: event.etag ?? null,
      title,
      description: event.description ?? null,
      location: event.location ?? null,
      start_at: startAt,
      end_at: endAt,
      is_all_day: Boolean(event.start?.date && !event.start?.dateTime),
      event_status: eventStatus,
      organizer_email: event.organizer?.email ?? null,
      html_link: event.htmlLink ?? null,
      conference_url: event.hangoutLink ?? null,
      raw_payload: sanitizeRawPayload(event),
      source_updated_at: event.updated ?? null,
      last_synced_at: now,
    }, { onConflict: "google_connection_id,google_event_id" })
    .select("id")
    .single();

  if (eventError || !storedEvent) throw new Error("calendar_event_upsert_failed");

  const { data: existingMeeting, error: meetingLookupError } = await admin
    .from("meetings")
    .select("id,status")
    .eq("calendar_event_id", storedEvent.id)
    .maybeSingle();
  if (meetingLookupError) throw new Error("meeting_lookup_failed");

  const detection = detectFsMeeting(title);

  if (!detection) {
    if (existingMeeting && existingMeeting.status !== "CANCELLED") {
      const { error } = await admin
        .from("meetings")
        .update({ status: "CANCELLED" })
        .eq("id", existingMeeting.id);
      if (error) throw new Error("meeting_exclusion_update_failed");
    }
    return;
  }

  const cancelled = eventStatus === "cancelled" || detection.cancelled;
  let meetingStatus = cancelled ? "CANCELLED" : (existingMeeting?.status ?? "DETECTED");
  if (!cancelled && meetingStatus === "CANCELLED") meetingStatus = "DETECTED";

  const { error: meetingError } = await admin
    .from("meetings")
    .upsert({
      calendar_event_id: storedEvent.id,
      fs_user_id: context.connection.user_id,
      organization_id: context.organizationId,
      meeting_type: detection.meetingType,
      status: meetingStatus,
      scheduled_start_at: startAt,
      scheduled_end_at: endAt,
      source: "GOOGLE_CALENDAR",
      detection_rule: detection.ruleId,
    }, { onConflict: "calendar_event_id" });

  if (meetingError) throw new Error("meeting_upsert_failed");
}

export async function syncGoogleCalendarConnection(
  connectionId: string,
  options: { accessToken?: string; watchId?: string; retriedAfterGone?: boolean } = {},
): Promise<{ eventCount: number; syncTokenStored: boolean }> {
  const context = await loadConnectionContext(connectionId);
  const accessToken = await accessTokenForConnection(context.connection, options.accessToken);
  const watch = options.watchId
    ? await (async () => {
        const admin = createAdminClient();
        const { data, error } = await admin
          .from("calendar_watch_channels")
          .select("id,channel_id,resource_id,sync_token,expiration_at,status")
          .eq("id", options.watchId)
          .eq("google_connection_id", connectionId)
          .maybeSingle();
        if (error) throw new Error("calendar_watch_lookup_failed");
        return data as WatchRow | null;
      })()
    : await latestActiveWatch(connectionId);

  if (!watch) throw new Error("calendar_watch_missing");

  const syncToken = watch.sync_token;
  const initialTimeMin = syncToken
    ? null
    : new Date(Date.now() - INITIAL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  let eventCount = 0;

  for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
    let response;
    try {
      response = await listCalendarEventsPage({
        accessToken,
        calendarId: context.connection.calendar_id,
        syncToken,
        pageToken,
        initialTimeMin,
      });
    } catch (error) {
      if (
        error instanceof GoogleCalendarApiError
        && error.status === 410
        && syncToken
        && !options.retriedAfterGone
      ) {
        const admin = createAdminClient();
        await admin
          .from("calendar_watch_channels")
          .update({ sync_token: null })
          .eq("id", watch.id);
        return syncGoogleCalendarConnection(connectionId, {
          accessToken,
          watchId: watch.id,
          retriedAfterGone: true,
        });
      }
      throw error;
    }

    for (const event of response.items ?? []) {
      await upsertCalendarEventAndMeeting(context, event);
      eventCount += 1;
    }

    pageToken = response.nextPageToken ?? null;
    nextSyncToken = response.nextSyncToken ?? nextSyncToken;
    if (!pageToken) break;
    if (page === MAX_SYNC_PAGES - 1) throw new Error("calendar_sync_page_limit");
  }

  const admin = createAdminClient();
  const updatePayload: Record<string, unknown> = {
    last_synced_at: new Date().toISOString(),
  };
  if (nextSyncToken) updatePayload.sync_token = nextSyncToken;

  const { error: watchUpdateError } = await admin
    .from("calendar_watch_channels")
    .update(updatePayload)
    .eq("id", watch.id);

  if (watchUpdateError) throw new Error("calendar_watch_sync_state_update_failed");

  return { eventCount, syncTokenStored: Boolean(nextSyncToken) };
}

export async function ensureCalendarWatch(
  connectionId: string,
  appOrigin: string,
  options: { accessToken?: string; force?: boolean } = {},
): Promise<{ watchId: string; renewed: boolean }> {
  const context = await loadConnectionContext(connectionId);
  const currentWatch = await latestActiveWatch(connectionId);

  if (
    currentWatch
    && !options.force
    && new Date(currentWatch.expiration_at).getTime() > Date.now() + WATCH_RENEW_BEFORE_MS
  ) {
    await syncGoogleCalendarConnection(connectionId, {
      accessToken: options.accessToken,
      watchId: currentWatch.id,
    });
    return { watchId: currentWatch.id, renewed: false };
  }

  const accessToken = await accessTokenForConnection(context.connection, options.accessToken);
  const channelId = randomUUID();
  const channelToken = randomBytes(32).toString("base64url");
  const tokenHash = hashCalendarChannelToken(channelToken);
  const webhookUrl = new URL("/api/webhooks/google-calendar", appOrigin).toString();

  const watchResponse = await watchCalendarEvents({
    accessToken,
    calendarId: context.connection.calendar_id,
    channelId,
    channelToken,
    webhookUrl,
  });

  const expirationMs = Number(watchResponse.expiration ?? (Date.now() + WATCH_DEFAULT_TTL_MS));
  const expirationAt = new Date(
    Number.isFinite(expirationMs) ? expirationMs : Date.now() + WATCH_DEFAULT_TTL_MS,
  ).toISOString();

  const admin = createAdminClient();
  const { data: newWatch, error: insertError } = await admin
    .from("calendar_watch_channels")
    .insert({
      google_connection_id: connectionId,
      channel_id: channelId,
      resource_id: watchResponse.resourceId,
      token_hash: tokenHash,
      sync_token: currentWatch?.sync_token ?? null,
      expiration_at: expirationAt,
      status: "ACTIVE",
    })
    .select("id")
    .single();

  if (insertError || !newWatch) throw new Error("calendar_watch_persist_failed");

  if (currentWatch) {
    await admin
      .from("calendar_watch_channels")
      .update({ status: "REPLACED" })
      .eq("id", currentWatch.id);

    try {
      await stopCalendarWatch({
        accessToken,
        channelId: currentWatch.channel_id,
        resourceId: currentWatch.resource_id,
      });
    } catch (error) {
      console.warn("calendar_old_watch_stop_failed", { code: safeCalendarErrorCode(error) });
    }
  }

  await syncGoogleCalendarConnection(connectionId, {
    accessToken,
    watchId: newWatch.id,
  });

  return { watchId: newWatch.id, renewed: true };
}

export async function renewExpiringCalendarWatches(
  appOrigin: string,
): Promise<{ checked: number; renewed: number; failed: number }> {
  const admin = createAdminClient();
  const threshold = new Date(Date.now() + WATCH_RENEW_BEFORE_MS).toISOString();

  const { data, error } = await admin
    .from("calendar_watch_channels")
    .select("google_connection_id")
    .eq("status", "ACTIVE")
    .lte("expiration_at", threshold)
    .limit(100);

  if (error) throw new Error("calendar_watch_renewal_lookup_failed");

  const connectionIds = [...new Set((data ?? []).map((row) => row.google_connection_id as string))];
  let renewed = 0;
  let failed = 0;

  for (const connectionId of connectionIds) {
    try {
      await ensureCalendarWatch(connectionId, appOrigin, { force: true });
      renewed += 1;
    } catch (error) {
      failed += 1;
      console.error("calendar_watch_renewal_failed", {
        connection_id: connectionId,
        code: safeCalendarErrorCode(error),
      });
    }
  }

  return { checked: connectionIds.length, renewed, failed };
}
