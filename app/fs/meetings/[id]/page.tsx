import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createClient } from "@/lib/supabase/server";
import { buildPreparationPrompt } from "@/lib/preparation/prompt";
import { loadMedicalFsE1Skill } from "@/lib/skills/loader";
import type { PreparationResult } from "@/lib/preparation/schema";
import { CopyTextButton } from "./copy-text-button";
import { savePreparationFromPaste } from "./preparation-actions";

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

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_MESSAGES: Record<string, { tone: "success" | "error"; text: string }> = {
  prep_saved: { tone: "success", text: "事前準備を保存しました。" },
  prep_invalid_json: {
    tone: "error",
    text: "ChatGPTの回答形式を確認してください。JSONとして読み取れませんでした。",
  },
  prep_not_e1: { tone: "error", text: "事前準備は現在E1商談のみ対応しています。" },
  prep_forbidden: { tone: "error", text: "この商談を確認する権限がありません。" },
  prep_save_failed: { tone: "error", text: "保存に失敗しました。時間を置いて再度お試しください。" },
};

export default async function MeetingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ status?: string }>;
}) {
  const user = await requireAuthorizedUser();
  const { id } = await params;
  const statusParam = (await searchParams)?.status;
  const supabase = await createClient();

  const { data: meeting, error } = await supabase
    .from("meetings")
    .select(
      "id,meeting_type,status,scheduled_start_at,scheduled_end_at,detection_rule,calendar_events!inner(title,description,location,html_link,conference_url,event_status),profiles!meetings_fs_user_id_fkey(display_name,email)",
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !meeting) notFound();

  const event = relation(meeting.calendar_events);
  const owner = relation(meeting.profiles);
  const isE1 = meeting.meeting_type === "E1";

  const { data: preparationRow } = isE1
    ? await supabase
        .from("meeting_preparations")
        .select(
          "status,source_mode,attempt_count,generated_at,research_mode,grounding_status,research_model,facts,hypotheses,needs_confirmation,clinic_summary,current_measures,medical_services,doctor,area,competitors,seo,meo,portals,sales_hypotheses,proposal_candidates,objections,recommended_responses,must_ask,withdrawal_conditions,key_points,talk_script_markdown,sources",
        )
        .eq("meeting_id", id)
        .maybeSingle()
    : { data: null };

  const preparation = preparationRow as (PreparationResult & {
    status: string;
    source_mode: string;
    attempt_count: number;
    generated_at: string | null;
    research_mode: "GROUNDED" | "DEGRADED" | null;
    grounding_status: "SUCCESS" | "UNAVAILABLE" | "FAILED" | null;
    research_model: string | null;
  }) | null;

  let prompt: string | null = null;
  if (isE1) {
    try {
      const skill = await loadMedicalFsE1Skill();
      prompt = buildPreparationPrompt({
        clinicName: event?.title ?? meeting.detection_rule ?? "対象医院",
        calendarTitle: event?.title ?? "",
        scheduledStartAt: meeting.scheduled_start_at,
        calendarDescription: event?.description ?? null,
        skillContent: skill.content,
      });
    } catch (promptError) {
      console.error("preparation_prompt_build_failed", {
        meeting_id: id,
        code: promptError instanceof Error ? promptError.message : "unknown",
      });
    }
  }

  const statusMessage = statusParam ? STATUS_MESSAGES[statusParam] : undefined;
  const saveAction = savePreparationFromPaste.bind(null, id);

  return (
    <AppShell user={user}>
      <p className="text-sm font-medium text-primary">{meeting.meeting_type}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">
        {event?.title ?? "商談"}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {formatDate(meeting.scheduled_start_at)} / {owner?.display_name ?? owner?.email ?? "—"}
      </p>

      {statusMessage ? (
        <p className="mt-4 rounded-md border bg-card px-4 py-3 text-sm">
          {statusMessage.tone === "error" ? "エラー: " : ""}
          {statusMessage.text}
        </p>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><h2 className="font-semibold">Calendar情報</h2></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p><span className="text-muted-foreground">状態:</span> {meeting.status}</p>
            <p><span className="text-muted-foreground">場所:</span> {event?.location ?? "—"}</p>
            <p><span className="text-muted-foreground">検知ルール:</span> {meeting.detection_rule ?? "—"}</p>
            {event?.conference_url ? (
              <a className="font-medium text-primary underline" href={event.conference_url} rel="noreferrer" target="_blank">
                オンライン商談URLを開く
              </a>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><h2 className="font-semibold">事前準備</h2></CardHeader>
          <CardContent>
            {!isE1 ? (
              <p className="text-sm text-muted-foreground">
                事前準備は現在E1商談のみ対応しています。この商談は{meeting.meeting_type}のため対応外です。
              </p>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">
                    ①プロンプトをコピー → ②自分のChatGPTに貼って調査 → ③回答をコピーして下に貼り付け → ④保存
                  </p>
                  {prompt ? (
                    <CopyTextButton className="mt-3" label="ChatGPTで事前準備：プロンプトをコピー" text={prompt} />
                  ) : (
                    <p className="mt-3 text-sm font-medium">
                      エラー: プロンプトの生成に失敗しました。Skillファイルを確認してください。
                    </p>
                  )}
                </div>

                {preparation?.source_mode === "API" ? (
                  <div className="rounded-md border bg-card p-3 text-sm">
                    <p className="font-medium">
                      {preparation.status === "READY" && `自動生成済み（${preparation.research_model ?? "Gemini"}）`}
                      {preparation.status === "PREPARING" && "Gemini自動生成中です。しばらくしてから再読み込みしてください。"}
                      {preparation.status === "FAILED" && "自動生成に失敗しました。手動ChatGPTフローをご利用ください。"}
                    </p>
                    {preparation.research_mode ? (
                      <p className="mt-1 text-xs">
                        {preparation.research_mode === "GROUNDED" ? (
                          <span className="text-emerald-600 dark:text-emerald-400">Web検索済み</span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">
                            Web検索未実施（Free Tier制限）— 事実は未確認、要確認事項に整理済み
                          </span>
                        )}
                      </p>
                    ) : null}
                    {preparation.status !== "PREPARING" ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        最終生成日時: {formatDate(preparation.generated_at)}
                      </p>
                    ) : null}
                    {preparation.status === "READY" ? (
                      <Link className="mt-2 inline-block text-primary underline" href={`/fs/meetings/${id}/material`}>
                        AI商談資料を開く
                      </Link>
                    ) : null}
                  </div>
                ) : null}

                <form action={saveAction} className="space-y-3">
                  <label className="block text-sm font-medium" htmlFor="pastedText">
                    ChatGPTの調査結果を貼り付け
                  </label>
                  <textarea
                    className="h-48 w-full rounded-md border bg-card p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                    id="pastedText"
                    name="pastedText"
                    placeholder="ChatGPTの回答（```json ... ``` を含む全文）をそのまま貼り付けてください"
                    required
                  />
                  <Button type="submit">
                    {preparation ? "再保存する" : "保存する"}
                  </Button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {isE1 && preparation?.status === "READY" ? (
        <div className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <h2 className="font-semibold">商談準備サマリー</h2>
              <p className="text-xs text-muted-foreground">
                {preparation.source_mode === "MANUAL_CHATGPT" ? "手動ChatGPT貼り付け" : "API自動生成"}
                {" "}/ 更新回数 {preparation.attempt_count}
                {" "}/ 最終更新 {formatDate(preparation.generated_at)}
              </p>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
              <ListSection items={preparation.proposal_candidates} title="この医院に何を提案するか" />
              <ListSection items={preparation.sales_hypotheses} title="なぜその商材なのか" />
              <ListSection items={preparation.key_points} title="刺しポイント" />
              <ListSection items={preparation.objections} title="想定OUT" />
              <ListSection items={preparation.recommended_responses} title="推奨返し" />
              <ListSection items={preparation.must_ask} title="E1で必ず確認すること" />
              <ListSection items={preparation.withdrawal_conditions} title="撤退条件 / 提案を切り替える条件" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><h2 className="font-semibold">事実・仮説・要確認</h2></CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-3">
              <div>
                <h3 className="text-sm font-semibold">事実（Facts）</h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {preparation.facts.map((fact, index) => (
                    <li key={`fact-${index}`}>
                      {fact.statement}
                      {fact.source_url ? (
                        <>
                          {" "}
                          <a className="text-primary underline" href={fact.source_url} rel="noreferrer" target="_blank">
                            [source]
                          </a>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
              <ListSection items={preparation.hypotheses} title="仮説（Hypotheses）" />
              <ListSection items={preparation.needs_confirmation} title="要確認（Needs Confirmation）" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><h2 className="font-semibold">医院情報</h2></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>{preparation.clinic_summary}</p>
              <div className="grid gap-4 md:grid-cols-2">
                <ListSection items={preparation.current_measures} title="現在施策" />
                <ListSection items={preparation.medical_services} title="診療内容" />
                <ListSection items={preparation.competitors} title="競合" />
                <ListSection items={preparation.portals} title="他媒体" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <p><span className="text-muted-foreground">Doctor:</span> {preparation.doctor || "—"}</p>
                <p><span className="text-muted-foreground">Area:</span> {preparation.area || "—"}</p>
                <p><span className="text-muted-foreground">SEO:</span> {preparation.seo || "—"}</p>
                <p><span className="text-muted-foreground">MEO:</span> {preparation.meo || "—"}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">事前準備＋E1トークスクリプト</h2>
                <CopyTextButton label="全文コピー" text={preparation.talk_script_markdown} />
              </div>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                {preparation.talk_script_markdown}
              </pre>
            </CardContent>
          </Card>

          {preparation.sources.length > 0 ? (
            <Card>
              <CardHeader><h2 className="font-semibold">Sources</h2></CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {preparation.sources.map((source, index) => (
                    <li key={`source-${index}`}>
                      <a className="text-primary underline" href={source.url} rel="noreferrer" target="_blank">
                        {source.label || source.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </AppShell>
  );
}
