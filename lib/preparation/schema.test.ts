import { describe, expect, it } from "vitest";
import { PreparationResultSchema } from "./schema";

const minimalValid = {
  talk_script_markdown: "# 【事前準備】テスト医院\n...\n# 【E1】テスト医院｜トークスクリプト\n...",
};

const fullValid = {
  facts: [{ statement: "自費診療を実施している", source_url: "https://example.com/clinic" }],
  hypotheses: ["自由診療の比率を増やしたいはず"],
  needs_confirmation: ["現在の広告予算"],
  clinic_summary: "地域密着型の内科クリニック",
  current_measures: ["マイナビ掲載中"],
  medical_services: ["内科", "眼科"],
  doctor: "院長 山田太郎",
  area: "東京都渋谷区",
  competitors: ["近隣クリニックA"],
  seo: "指名検索は強いが一般検索は弱い",
  meo: "口コミ数が少ない",
  portals: ["EPARK"],
  sales_hypotheses: ["新患獲得に課題がありそう"],
  proposal_candidates: ["MEO対策プラン"],
  objections: ["今くらいで十分"],
  recommended_responses: ["理想の患者数を聞き返す"],
  must_ask: ["決裁者は誰か"],
  withdrawal_conditions: ["予算が確保できない場合"],
  key_points: ["口コミ改善で新患増加が見込める"],
  talk_script_markdown: minimalValid.talk_script_markdown,
  sources: [{ label: "公式サイト", url: "https://example.com" }],
};

describe("PreparationResultSchema", () => {
  it("accepts a minimal payload with only the required field and fills defaults", () => {
    const result = PreparationResultSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.facts).toEqual([]);
      expect(result.data.clinic_summary).toBe("");
    }
  });

  it("accepts a fully populated payload", () => {
    const result = PreparationResultSchema.safeParse(fullValid);
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing talk_script_markdown", () => {
    const withoutScript: Partial<typeof fullValid> = { ...fullValid };
    delete withoutScript.talk_script_markdown;
    const result = PreparationResultSchema.safeParse(withoutScript);
    expect(result.success).toBe(false);
  });

  it("rejects a fact with an invalid source_url", () => {
    const result = PreparationResultSchema.safeParse({
      ...fullValid,
      facts: [{ statement: "x", source_url: "not-a-url" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a source without a valid url", () => {
    const result = PreparationResultSchema.safeParse({
      ...fullValid,
      sources: [{ label: "broken" }],
    });
    expect(result.success).toBe(false);
  });
});
