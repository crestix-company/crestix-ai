import { ShieldCheck } from "lucide-react";
import { signInWithGoogle } from "./actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { hasPublicEnv } from "@/lib/config/env";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const configured = hasPublicEnv();
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-4 flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold">CRESTIX AI OS</h1>
          <p className="text-sm text-muted-foreground">許可されたCRESTIX Workspaceアカウントでログインしてください。</p>
        </CardHeader>
        <CardContent>
          {configured ? (
            <form action={signInWithGoogle}>
              <Button className="w-full" type="submit">Googleでログイン</Button>
            </form>
          ) : (
            <div className="rounded-md border bg-muted p-4 text-sm">
              Supabase接続は未設定です。`.env.example` を参照してローカル環境変数を設定してください。
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
