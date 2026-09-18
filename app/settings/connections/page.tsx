import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createClient } from "@/lib/supabase/server";
import { repairGoogleCalendarConnection } from "./actions";

export const dynamic = "force-dynamic";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>;
}) {
  const user = await requireAuthorizedUser();
  const params = await searchParams;
  const supabase = await createClient();

  const { data: connection } = await supabase
    .from("google_connections")
    .select("id,google_email,is_active,updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: watch } = connection
    ? await supabase
        .from("calendar_watch_channels")
        .select("status,expiration_at,last_synced_at")
        .eq("google_connection_id", connection.id)
        .eq("status", "ACTIVE")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const statusMessage =
    params?.status === "ready"
      ? "Google Calendar監視と同期を更新しました。"
      : params?.status === "repair_failed"
        ? "Calendar同期の再設定に失敗しました。管理ログを確認してください。"
        : null;

  return (
    <AppShell user={user}>
      <h1 className="text-3xl font-semibold tracking-tight">接続設定</h1>

      {statusMessage ? (
        <p className="mt-4 rounded-md border bg-card px-4 py-3 text-sm">{statusMessage}</p>
      ) : null}

      <Card className="mt-6 max-w-2xl">
        <CardHeader>
          <h2 className="font-semibold">Google Calendar</h2>
          <p className="text-sm text-muted-foreground">
            Push Notification + syncTokenでFS商談を自動同期します。
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Googleアカウント</dt>
              <dd className="mt-1 font-medium">{connection?.google_email ?? "未接続"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Watch</dt>
              <dd className="mt-1 font-medium">{watch?.status ?? "未登録"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">最終同期</dt>
              <dd className="mt-1 font-medium">{formatDate(watch?.last_synced_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Watch期限</dt>
              <dd className="mt-1 font-medium">{formatDate(watch?.expiration_at)}</dd>
            </div>
          </dl>

          {connection ? (
            <form action={repairGoogleCalendarConnection}>
              <Button type="submit" variant="secondary">
                Calendar監視・同期を再設定
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Googleログインを完了するとCalendar接続が作成されます。
            </p>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
