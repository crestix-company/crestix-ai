import { describe, expect, it } from "vitest";
import { detectFsMeeting } from "./meeting-detection";

describe("detectFsMeeting", () => {
  it("detects the current medical E1 Calendar naming rule", () => {
    expect(detectFsMeeting("【お打ち合わせ①】テスト内科 様")).toMatchObject({
      meetingType: "E1",
      ruleId: "medical-current-e1",
      cancelled: false,
    });
  });

  it("keeps rescheduled current medical meetings active", () => {
    expect(detectFsMeeting("リスケ【お打ち合わせ①】テスト眼科 様")).toMatchObject({
      meetingType: "E1",
      cancelled: false,
    });
  });

  it("marks title-level cancellations", () => {
    expect(detectFsMeeting("キャンセル【お打ち合わせ①】テスト医院 様")).toMatchObject({
      meetingType: "E1",
      cancelled: true,
    });
  });

  it("does not misclassify internal 商談 tasks", () => {
    expect(detectFsMeeting("商談動画→内科＋眼科確認")).toBeNull();
    expect(detectFsMeeting("最終商談内容声だし＋チェック")).toBeNull();
  });

  it("supports the v1.2 legacy explicit markers", () => {
    expect(detectFsMeeting("【E1】clinic")).toMatchObject({ meetingType: "E1" });
    expect(detectFsMeeting("【E2】clinic")).toMatchObject({ meetingType: "E2" });
    expect(detectFsMeeting("【HD①】clinic")).toMatchObject({ meetingType: "HD" });
    expect(detectFsMeeting("【HD回収オンライン】clinic")).toMatchObject({ meetingType: "HD" });
  });
});
