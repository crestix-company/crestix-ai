import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type MeetingStatus =
  | "DETECTED"
  | "PREPARING"
  | "READY"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "LIVE"
  | "COMPLETED"
  | "CANCELLED";

function formatDate(value: string | null) {
  if (!value) return "日時未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function ownerName(profile: unknown) {
  const row = Array.isArray(profile) ? profile[0] : profile;
  if (!row || typeof row !== "object") return "—";
  const value = row as { display_name?: string | null; email?: string | null };
  return value.display_name ?? value.email ?? "—";
}

function eventTitle(event: unknown) {
  const row = Array.isArray(event) ? event[0] : event;
  if (!row || typeof row !== "object") return "無題の商談";
  return (row as { title?: string | null }).title || "無題の商談";
}

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>;
}) {
  const user = await requireAuthorizedUser();
  const params = await searchParams;
  const q = params?.q?.trim().toLowerCase() ?? "";
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("meetings")
    .select(
      "id,meeting_type,status,scheduled_start_at,scheduled_end_at,calendar_events!inner(title,event_status),profiles!meetings_fs_user_id_fkey(display_name,email)",
    )
    .neq("status", "CANCELLED")
    .order("scheduled_start_at", { ascending: true })
    .limit(200);

  const meetings = (error ? [] : data ?? []).filter((meeting) => {
    if (!q) return true;
    return eventTitle(meeting.calendar_events).toLowerCase().includes(q);
  });

  const count = (statuses: MeetingStatus[]) =>
    meetings.filter((meeting) => statuses.includes(meeting.status as MeetingStatus)).length;

  const cards = [
    ["準備中", count(["DETECTED", "PREPARING"])],
    ["準備完了", count(["READY"])],
    ["要確認", count(["NEEDS_REVIEW", "FAILED"])],
    ["商談済み", count(["COMPLETED"])],
  ] as const;

  return (
    <AppShell user={user}>
      <header className="mb-8">
        <p className="text-sm font-medium text-primary">FS SALES</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">商談</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Google Calendarから自動検知したFS商談です。Calendar UIは重複して作りません。
        </p>
      </header>

      <form className="mb-6 max-w-xl" method="get">
        <input
          aria-label="商談を検索"
          className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          defaultValue={params?.q ?? ""}
          name="q"
          placeholder="医院名・商談名で検索"
          type="search"
        />
      </form>

      <div className="grid gap-4 md:grid-cols-4">
        {cards.map(([label, value]) => (
          <Card key={label}>
            <CardHeader><p className="text-sm text-muted-foreground">{label}</p></CardHeader>
            <CardContent><p className="text-3xl font-semibold tabular-nums">{value}</p></CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <h2 className="font-semibold">Calendar検知済み商談</h2>
        </CardHeader>
        <CardContent>
          {meetings.length === 0 ? (
            <div className="py-10 text-center">
              <p className="font-medium">対象商談はまだありません</p>
              <p className="mt-2 text-sm text-muted-foreground">
                対象のCalendarイベントが同期されるとここへ自動表示されます。
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {meetings.map((meeting) => (
                <Link
                  className="grid gap-2 py-4 transition-opacity hover:opacity-70 md:grid-cols-[1fr_110px_180px_180px]"
                  href={`/fs/meetings/${meeting.id}`}
                  key={meeting.id}
                >
                  <div>
                    <p className="font-medium">{eventTitle(meeting.calendar_events)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {ownerName(meeting.profiles)}
                    </p>
                  </div>
                  <p className="text-sm">{meeting.meeting_type}</p>
                  <p className="text-sm">{formatDate(meeting.scheduled_start_at)}</p>
                  <p className="text-sm">{meeting.status}</p>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
