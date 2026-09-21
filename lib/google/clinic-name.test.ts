import { describe, expect, it } from "vitest";
import { extractClinicName } from "./clinic-name";

describe("extractClinicName", () => {
  it("strips the E1 marker and trailing honorific", () => {
    expect(extractClinicName("【お打ち合わせ①】渋谷胃腸クリニック 様")).toBe("渋谷胃腸クリニック");
  });

  it("strips the E2 marker", () => {
    expect(extractClinicName("【お打ち合わせ②】テスト眼科 様")).toBe("テスト眼科");
  });

  it("strips known operational prefixes (リスケ/キャンセル) glued onto the title", () => {
    expect(extractClinicName("リスケ【お打ち合わせ①】渋谷胃腸クリニック 様")).toBe("渋谷胃腸クリニック");
    expect(extractClinicName("キャンセル【お打ち合わせ①】渋谷胃腸クリニック 様")).toBe("渋谷胃腸クリニック");
  });

  it("handles a missing trailing honorific gracefully", () => {
    expect(extractClinicName("【お打ち合わせ①】渋谷胃腸クリニック")).toBe("渋谷胃腸クリニック");
  });

  it("returns an empty string when nothing meaningful remains", () => {
    expect(extractClinicName("【お打ち合わせ①】")).toBe("");
  });
});
