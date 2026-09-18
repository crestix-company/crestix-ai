"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center p-6 text-center">
      <div><h1 className="text-2xl font-semibold">処理を完了できませんでした</h1><p className="mt-2 text-sm text-muted-foreground">時間を置いて再試行してください。</p><Button className="mt-6" onClick={reset}>再試行</Button></div>
    </main>
  );
}
