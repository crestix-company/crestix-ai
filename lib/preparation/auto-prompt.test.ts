import { describe, expect, it } from "vitest";
import type { SanitizedIsHandoff } from "@/lib/preparation/is-handoff";
import { buildAutoPreparationPrompt, buildDegradedResearchPrompt, buildMaterialPrompt, buildResearchPrompt } from "./auto-prompt";

const research = {
  summary: "公式サイトによると自費診療メニューがある",
  sources: [{ url: "https://example.com/clinic", title: "公式サイト" }],
  searchCallCount: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "gemini-2.5-flash-lite",
  researchMode: "GROUNDED" as const,
  groundingStatus: "SUCCESS" as const,
};

const sanitizedHandoff: SanitizedIsHandoff = {
  contact_role: "院長",
  paid_awareness: "有り",
  patient_acceptance: "可能",
  personality_note: "穏やかな方",
  article_status: "記事なし",
  concern_exists: "有",
  concern_detail: "予算が厳しいと聞いている",
  growth_area: "特になし",
  new_patient_capacity: "そこそこ",
  prior_outcome: "アウト無",
  prior_outcome_detail: null,
  focus_department: "特になし",
  homepage_url: "https://shibuya-clinic.example.com",
  notes: "院長は物腰柔らかい",
};

describe("buildResearchPrompt", () => {
  it("never embeds the Master Skill or asks for sales judgments", () => {
    const prompt = buildResearchPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "【お打ち合わせ①】テストクリニック 様",
      scheduledStartAt: "2026-09-25T01:00:00.000Z",
    });

    expect(prompt).toContain("テストクリニック");
    expect(prompt).toContain("公開されているWeb情報のみ");
    expect(prompt).toContain("営業判断は行わない");
    expect(prompt).not.toContain("medical-fs-e1-complete");
  });

  it("states the Calendar HP URL as the top research priority when provided", () => {
    const prompt = buildResearchPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      homepageUrl: "https://shibuya-clinic.example.com",
    });

    expect(prompt).toContain("Calendar記載のHP URL: https://shibuya-clinic.example.com");
    expect(prompt).toContain("1. Calendar記載のHP URL");
  });

  it("omits the HP URL line when none was provided", () => {
    const prompt = buildResearchPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
    });

    expect(prompt).not.toContain("Calendar記載のHP URL:");
  });
});

describe("buildDegradedResearchPrompt", () => {
  it("never claims web research was performed and routes web-verification items to a confirm-at-meeting list", () => {
    const prompt = buildDegradedResearchPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "【お打ち合わせ①】テストクリニック 様",
      scheduledStartAt: "2026-09-25T01:00:00.000Z",
    });

    expect(prompt).toContain("Google Search（Web検索）を使用していません");
    expect(prompt).toContain("調査した");
    expect(prompt).toContain("SEO");
    expect(prompt).toContain("MEO");
    expect(prompt).toContain("競合");
    expect(prompt).toContain("院長");
    expect(prompt).toContain("商談当日に確認すべき事項");
    expect(prompt).not.toContain("medical-fs-e1-complete");
  });
});

describe("buildAutoPreparationPrompt", () => {
  it("injects an explicit DEGRADED-mode constraint block when research.researchMode is DEGRADED, forbidding facts/hypotheses from claiming unverified web content", () => {
    const degradedResearch = { ...research, researchMode: "DEGRADED" as const, groundingStatus: "UNAVAILABLE" as const, sources: [] };
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      sanitizedIsHandoff: null,
      research: degradedResearch,
      skillContent: "content",
    });

    expect(prompt).toContain("Research Mode: DEGRADED");
    expect(prompt).toContain("needs_confirmationへ入れ");
  });

  it("omits the DEGRADED-mode constraint block when research.researchMode is GROUNDED", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      sanitizedIsHandoff: null,
      research,
      skillContent: "content",
    });

    expect(prompt).not.toContain("Research Mode: DEGRADED");
  });

  it("renders the sanitized IS handoff fields, never any raw Calendar description text", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      sanitizedIsHandoff: sanitizedHandoff,
      research,
      skillContent: "content",
    });

    expect(prompt).toContain("担当者の役職: 院長");
    expect(prompt).toContain("懸念の詳細: 予算が厳しいと聞いている");
    expect(prompt).toContain("HP URL: https://shibuya-clinic.example.com");
    expect(prompt).not.toContain("非公開");
  });

  it("shows a placeholder when there is no IS handoff data at all", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      sanitizedIsHandoff: null,
      research,
      skillContent: "content",
    });

    expect(prompt).toContain("IS引継ぎメモの記載なし");
  });

  it("instructs assumed_outs generation to prioritize an already-known IS concern/prior OUT", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      sanitizedIsHandoff: sanitizedHandoff,
      research,
      skillContent: "content",
    });

    expect(prompt).toContain("assumed_outs");
    expect(prompt).toContain("最優先で");
    expect(prompt).toContain("today_conclusion");
    expect(prompt).toContain("e2_conditions");
  });

  it("instructs facts to use only Research Agent sources and never invent URLs", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      sanitizedIsHandoff: null,
      research,
      skillContent: "content",
    });

    expect(prompt).toContain("URLを創作しないこと");
    expect(prompt).toContain("facts");
    expect(prompt).toContain("hypotheses");
    expect(prompt).toContain("needs_confirmation");
  });
});

describe("buildMaterialPrompt", () => {
  it("embeds the clinic name and preparation JSON and forbids inventing new facts", () => {
    const prompt = buildMaterialPrompt({
      clinicName: "テストクリニック",
      preparationJson: "{\"clinic_summary\":\"テスト\"}",
    });

    expect(prompt).toContain("テストクリニック");
    expect(prompt).toContain("clinic_summary");
    expect(prompt).toContain("創作しないこと");
  });
});
