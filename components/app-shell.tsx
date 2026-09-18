import Link from "next/link";
import { BriefcaseBusiness, LogOut, Settings, Shield } from "lucide-react";
import { signOut } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { AuthorizedUser } from "@/lib/auth/authorization";

export function AppShell({ user, children }: { user: AuthorizedUser; children: React.ReactNode }) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-b bg-card p-5 lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="mb-8">
          <p className="font-semibold">CRESTIX AI OS</p>
          <p className="text-xs text-muted-foreground">FS Sales AI</p>
        </div>
        <nav className="grid gap-1 text-sm" aria-label="メインナビゲーション">
          <Link className="flex items-center gap-3 rounded-md bg-muted px-3 py-2 font-medium" href="/fs/meetings">
            <BriefcaseBusiness className="size-4" aria-hidden="true" />商談
          </Link>
          <Link className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-muted" href="/settings/connections">
            <Settings className="size-4" aria-hidden="true" />接続設定
          </Link>
          {user.role === "ADMIN" ? (
            <Link className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-muted" href="/admin">
              <Shield className="size-4" aria-hidden="true" />管理
            </Link>
          ) : null}
        </nav>
        <div className="mt-8 border-t pt-4">
          <p className="truncate text-sm font-medium">{user.displayName ?? user.email}</p>
          <p className="truncate text-xs text-muted-foreground">{user.role}</p>
          <form action={signOut} className="mt-3">
            <Button className="w-full gap-2" type="submit" variant="secondary">
              <LogOut className="size-4" aria-hidden="true" />ログアウト
            </Button>
          </form>
        </div>
      </aside>
      <main className="p-6 lg:p-10">{children}</main>
    </div>
  );
}
