import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function relation<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAuthorizedUser();
  const { id } = await params;
  const supabase = await createClient();

  const { data: meeting, error } = await supabase
    .from("meetings")
    .select(
      "id,meeting_type,status,scheduled_start_at,scheduled_end_at,detection_rule,calendar_events!inner(title,description,location,html_link,conference_url,event_status),profiles!meetings_fs_user_id_fkey(display_name,email)",
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !meeting) notFound();

  const event = relation(meeting.calendar_events);
  const owner = relation(meeting.profiles);

  return (
    <AppShell user={user}>
      <p className="text-sm font-medium text-primary">{meeting.meeting_type}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">
        {event?.title ?? "商談"}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {formatDate(meeting.scheduled_start_at)} / {owner?.display_name ?? owner?.email ?? "—"}
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><h2 className="font-semibold">Calendar情報</h2></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p><span className="text-muted-foreground">状態:</span> {meeting.status}</p>
            <p><span className="text-muted-foreground">場所:</span> {event?.location ?? "—"}</p>
            <p><span className="text-muted-foreground">検知ルール:</span> {meeting.detection_rule ?? "—"}</p>
            {event?.conference_url ? (
              <a className="font-medium text-primary underline" href={event.conference_url} rel="noreferrer" target="_blank">
                オンライン商談URLを開く
              </a>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><h2 className="font-semibold">事前準備</h2></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Calendar検知はPhase 1で実装済みです。Skill実行・事実/仮説/要確認はPhase 2でここへ接続します。
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
