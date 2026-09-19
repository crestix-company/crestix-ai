import { describe, expect, it } from "vitest";
import { buildAutoPreparationPrompt, buildMaterialPrompt, buildResearchPrompt } from "./auto-prompt";

const research = {
  summary: "公式サイトによると自費診療メニューがある",
  sources: [{ url: "https://example.com/clinic", title: "公式サイト" }],
  searchCallCount: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
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
});

describe("buildAutoPreparationPrompt", () => {
  it("omits the Calendar description when include_private_calendar_notes is false", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      calendarDescription: "非公開のIS引き継ぎメモ：カード情報あり",
      includePrivateNotes: false,
      research,
      skillContent: "# SKILL MARKER",
    });

    expect(prompt).not.toContain("非公開のIS引き継ぎメモ");
    expect(prompt).toContain("# SKILL MARKER");
    expect(prompt).toContain("https://example.com/clinic");
  });

  it("includes the Calendar description only when include_private_calendar_notes is true", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      calendarDescription: "IS引き継ぎメモ",
      includePrivateNotes: true,
      research,
      skillContent: "# SKILL MARKER",
    });

    expect(prompt).toContain("IS引き継ぎメモ");
  });

  it("instructs facts to use only Research Agent sources and never invent URLs", () => {
    const prompt = buildAutoPreparationPrompt({
      clinicName: "テストクリニック",
      calendarTitle: "タイトル",
      scheduledStartAt: null,
      calendarDescription: null,
      includePrivateNotes: false,
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
