import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center p-6 text-center">
      <div><p className="text-sm font-medium text-primary">404</p><h1 className="mt-2 text-2xl font-semibold">ページが見つかりません</h1><Link className="mt-6 inline-block text-sm underline" href="/fs/meetings">商談へ戻る</Link></div>
    </main>
  );
}
