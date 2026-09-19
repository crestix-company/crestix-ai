import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createClient } from "@/lib/supabase/server";
import type { MaterialSlide } from "@/lib/preparation/material-schema";
import { CopyTextButton } from "../copy-text-button";

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

const STATUS_LABELS: Record<string, string> = {
  PENDING: "未生成",
  GENERATING: "生成中",
  READY: "生成完了",
  FAILED: "生成失敗",
};

export default async function MeetingMaterialPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAuthorizedUser();
  const { id } = await params;
  const supabase = await createClient();

  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id,calendar_events!inner(title)")
    .eq("id", id)
    .maybeSingle();

  if (meetingError || !meeting) notFound();

  const event = relation(meeting.calendar_events);

  const { data: material } = await supabase
    .from("meeting_materials")
    .select("status,title,executive_summary,slides,document_markdown,generated_at,error_safe")
    .eq("meeting_id", id)
    .maybeSingle();

  return (
    <AppShell user={user}>
      <p className="text-sm font-medium text-primary">AI商談資料</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">
        {material?.title || event?.title || "商談資料"}
      </h1>
      <Link className="mt-2 inline-block text-sm text-primary underline" href={`/fs/meetings/${id}`}>
        商談詳細に戻る
      </Link>

      <Card className="mt-6">
        <CardHeader>
          <h2 className="font-semibold">資料生成状態</h2>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>状態: {material ? STATUS_LABELS[material.status] ?? material.status : "未生成"}</p>
          {material?.generated_at ? <p>最終生成日時: {formatDate(material.generated_at)}</p> : null}
          {!material ? (
            <p className="text-muted-foreground">
              この商談の資料はまだ生成されていません。Gemini自動事前準備が完了すると自動的に作成されます。
            </p>
          ) : null}
          {material?.status === "FAILED" ? (
            <p className="text-muted-foreground">
              資料生成に失敗しました。事前準備自体は保存済みの場合があります。商談詳細で確認してください。
            </p>
          ) : null}
        </CardContent>
      </Card>

      {material?.status === "READY" ? (
        <div className="mt-6 space-y-6">
          <Card>
            <CardHeader><h2 className="font-semibold">Executive Summary</h2></CardHeader>
            <CardContent>
              <p className="text-sm">{material.executive_summary}</p>
            </CardContent>
          </Card>

          {(material.slides as MaterialSlide[]).map((slide, index) => (
            <Card key={`slide-${index}`}>
              <CardHeader>
                <h2 className="font-semibold">{slide.title}</h2>
                {slide.purpose ? <p className="text-xs text-muted-foreground">{slide.purpose}</p> : null}
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {slide.bullets.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {slide.bullets.map((bullet, bulletIndex) => (
                      <li key={`slide-${index}-bullet-${bulletIndex}`}>{bullet}</li>
                    ))}
                  </ul>
                ) : null}
                {slide.speaker_notes ? (
                  <p className="text-muted-foreground">
                    <span className="font-medium">Speaker Notes:</span> {slide.speaker_notes}
                  </p>
                ) : null}
                {slide.sources.length > 0 ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {slide.sources.map((source, sourceIndex) => (
                      <a
                        className="text-primary underline"
                        href={source}
                        key={`slide-${index}-source-${sourceIndex}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        [source]
                      </a>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">資料全文</h2>
                <CopyTextButton label="全文コピー" text={material.document_markdown ?? ""} />
              </div>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                {material.document_markdown}
              </pre>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </AppShell>
  );
}
