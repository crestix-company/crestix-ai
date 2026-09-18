import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const user = await requireAuthorizedUser();
  return (
    <AppShell user={user}>
      <header className="mb-8">
        <p className="text-sm font-medium text-primary">FS SALES</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">商談</h1>
        <p className="mt-2 text-sm text-muted-foreground">Calendarから検知したFS商談と準備状況を確認します。</p>
      </header>
      <div className="grid gap-4 md:grid-cols-4">
        {[
          ["準備中", "0"], ["準備完了", "0"], ["要確認", "0"], ["商談済み", "0"],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader><p className="text-sm text-muted-foreground">{label}</p></CardHeader>
            <CardContent><p className="text-3xl font-semibold tabular-nums">{value}</p></CardContent>
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <CardContent className="py-12 text-center">
          <p className="font-medium">商談はまだありません</p>
          <p className="mt-2 text-sm text-muted-foreground">Google Calendar連携はPhase 1で有効になります。</p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
