import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const user = await requireAuthorizedUser();
  return (
    <AppShell user={user}>
      <h1 className="text-3xl font-semibold tracking-tight">接続設定</h1>
      <Card className="mt-6 max-w-2xl">
        <CardHeader><h2 className="font-semibold">Google Calendar</h2></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Calendar接続とrefresh tokenの暗号化保存はPhase 1で実装します。</p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
