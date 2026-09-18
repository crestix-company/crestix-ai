import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireAuthorizedUser();
  if (user.role !== "ADMIN") notFound();
  return (
    <AppShell user={user}>
      <h1 className="text-3xl font-semibold tracking-tight">管理</h1>
      <Card className="mt-6">
        <CardContent className="py-10">
          <p className="font-medium">Phase 0 foundation</p>
          <p className="mt-2 text-sm text-muted-foreground">接続状態、job、エラー管理は後続Phaseで追加します。</p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
