import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireAuthorizedUser();
  if (user.role !== "ADMIN") notFound();

  const admin = createAdminClient();
  const [connections, watches, failedJobs] = await Promise.all([
    admin.from("google_connections").select("id", { count: "exact", head: true }),
    admin
      .from("calendar_watch_channels")
      .select("id", { count: "exact", head: true })
      .eq("status", "ACTIVE"),
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "FAILED"),
  ]);

  const stats = [
    ["Calendar接続", connections.count ?? 0],
    ["Active Watch", watches.count ?? 0],
    ["失敗Job", failedJobs.count ?? 0],
  ] as const;

  return (
    <AppShell user={user}>
      <h1 className="text-3xl font-semibold tracking-tight">管理</h1>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {stats.map(([label, value]) => (
          <Card key={label}>
            <CardHeader><p className="text-sm text-muted-foreground">{label}</p></CardHeader>
            <CardContent><p className="text-3xl font-semibold tabular-nums">{value}</p></CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardContent className="py-8">
          <p className="font-medium">Phase 1 Calendar monitoring</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Watch期限前の再登録と失敗Jobの再試行はVercel Cronで実行します。
          </p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
