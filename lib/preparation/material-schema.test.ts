import { describe, expect, it } from "vitest";
import { MaterialResultSchema } from "./material-schema";

const valid = {
  title: "【E1商談資料】テストクリニック",
  executive_summary: "自費診療の拡大余地が大きい",
  slides: [
    {
      title: "1. 医院サマリー",
      purpose: "医院の全体像を共有する",
      bullets: ["内科クリニック", "自由診療メニューあり"],
      speaker_notes: "院長は積極的",
      sources: ["https://example.com/clinic"],
    },
  ],
  document_markdown: "# 【E1商談資料】テストクリニック\n...",
};

describe("MaterialResultSchema", () => {
  it("accepts a valid material payload", () => {
    expect(MaterialResultSchema.safeParse(valid).success).toBe(true);
  });

  it("requires at least one slide", () => {
    const result = MaterialResultSchema.safeParse({ ...valid, slides: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL source", () => {
    const result = MaterialResultSchema.safeParse({
      ...valid,
      slides: [{ ...valid.slides[0], sources: ["not-a-url"] }],
    });
    expect(result.success).toBe(false);
  });

  it("fills slide defaults when only title is provided", () => {
    const result = MaterialResultSchema.safeParse({
      ...valid,
      slides: [{ title: "1. 医院サマリー" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slides[0].bullets).toEqual([]);
    }
  });
});
