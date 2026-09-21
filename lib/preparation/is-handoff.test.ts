import { describe, expect, it } from "vitest";
import { parseIsHandoff, sanitizeIsHandoff } from "./is-handoff";

const FULL_DESCRIPTION = `ISアポ取得者：前田
FS担当者：前川
メールアドレス：contact@example.com
医院電話番号：03-1234-5678
お名前：後藤 直樹
役職：院長
有償認識：有り
受け入れ：可能
人柄の印象：穏やかな方
記事名：記事なし
マイナビURL：https://example.com/mynavi
懸念点：有
懸念点（詳細）：予算が厳しいと聞いている
伸ばしていきたい領域：特になし
新規患者の受け入れ：そこそこ
トーク内容：アウト無
トーク内容（詳細）：
注力科目：特になし
HP URL：https://shibuya-clinic.example.com
その他備考：院長は物腰柔らかい`;

describe("parseIsHandoff", () => {
  it("returns null for a normal Calendar description with no IS handoff template", () => {
    expect(parseIsHandoff("普通の打ち合わせです。よろしくお願いします。")).toBeNull();
    expect(parseIsHandoff(null)).toBeNull();
    expect(parseIsHandoff(undefined)).toBeNull();
    expect(parseIsHandoff("")).toBeNull();
  });

  it("parses every known field from the full template", () => {
    const result = parseIsHandoff(FULL_DESCRIPTION);
    expect(result).toMatchObject({
      appointment_setter: "前田",
      fs_owner: "前川",
      contact_email: "contact@example.com",
      clinic_phone: "03-1234-5678",
      contact_name: "後藤 直樹",
      contact_role: "院長",
      paid_awareness: "有り",
      patient_acceptance: "可能",
      personality_note: "穏やかな方",
      article_status: "記事なし",
      article_url: "https://example.com/mynavi",
      concern_exists: "有",
      concern_detail: "予算が厳しいと聞いている",
      growth_area: "特になし",
      new_patient_capacity: "そこそこ",
      prior_outcome: "アウト無",
      focus_department: "特になし",
      homepage_url: "https://shibuya-clinic.example.com",
      notes: "院長は物腰柔らかい",
    });
  });

  it("is order-independent - a reshuffled template parses identically", () => {
    const reshuffled = `役職：院長
HP URL：https://shibuya-clinic.example.com
懸念点：有
お名前：後藤 直樹`;
    const result = parseIsHandoff(reshuffled);
    expect(result).toMatchObject({
      contact_role: "院長",
      homepage_url: "https://shibuya-clinic.example.com",
      concern_exists: "有",
      contact_name: "後藤 直樹",
    });
  });

  it("handles a partially-filled template (only some fields present) without crashing", () => {
    const result = parseIsHandoff("役職：院長\n有償認識：不明");
    expect(result).toMatchObject({ contact_role: "院長", paid_awareness: "不明" });
    expect(result?.homepage_url).toBeNull();
    expect(result?.concern_detail).toBeNull();
  });

  it("appends multi-line continuation text to the most recently opened field", () => {
    const multiline = `懸念点（詳細）：予算が厳しいと聞いている
過去に他社ツールを導入して失敗した経験があるとのこと
役職：院長`;
    const result = parseIsHandoff(multiline);
    expect(result?.concern_detail).toBe("予算が厳しいと聞いている\n過去に他社ツールを導入して失敗した経験があるとのこと");
    expect(result?.contact_role).toBe("院長");
  });

  it("distinguishes 受け入れ from the longer 新規患者の受け入れ label instead of substring-matching", () => {
    const result = parseIsHandoff("受け入れ：可能\n新規患者の受け入れ：そこそこ");
    expect(result?.patient_acceptance).toBe("可能");
    expect(result?.new_patient_capacity).toBe("そこそこ");
  });

  it("strips Google Meet auto-appended joining info instead of treating it as field content", () => {
    const withMeetNoise = `役職：院長
その他備考：特になし
-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-
Google Meet に参加: https://meet.google.com/abc-defg-hij
電話でも参加できます: (US) +1 555-0100 PIN: 123456789
-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-`;
    const result = parseIsHandoff(withMeetNoise);
    expect(result?.notes).toBe("特になし");
  });
});

describe("sanitizeIsHandoff", () => {
  it("excludes contact name, internal staff names, email, and phone - only sales-judgment fields survive", () => {
    const raw = parseIsHandoff(FULL_DESCRIPTION);
    expect(raw).not.toBeNull();
    const sanitized = sanitizeIsHandoff(raw!);

    expect(sanitized).not.toHaveProperty("contact_name");
    expect(sanitized).not.toHaveProperty("appointment_setter");
    expect(sanitized).not.toHaveProperty("fs_owner");
    expect(sanitized).not.toHaveProperty("contact_email");
    expect(sanitized).not.toHaveProperty("clinic_phone");
    expect(sanitized).not.toHaveProperty("article_url");

    expect(sanitized).toEqual({
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
    });
  });
});
