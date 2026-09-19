import { describe, expect, it } from "vitest";
import { extractJsonObject } from "./extract-json";

describe("extractJsonObject", () => {
  it("parses a fenced ```json block", () => {
    const text = "ここに調査結果です。\n\n```json\n{\"facts\": [], \"talk_script_markdown\": \"hello\"}\n```\n\n以上です。";
    expect(extractJsonObject(text)).toEqual({ facts: [], talk_script_markdown: "hello" });
  });

  it("parses a bare fenced block without the json language tag", () => {
    const text = "```\n{\"a\": 1}\n```";
    expect(extractJsonObject(text)).toEqual({ a: 1 });
  });

  it("parses raw JSON with surrounding prose and no fence", () => {
    const text = "回答は以下の通りです: {\"a\": {\"nested\": [1, 2, 3]}, \"b\": \"x\"} よろしくお願いします。";
    expect(extractJsonObject(text)).toEqual({ a: { nested: [1, 2, 3] }, b: "x" });
  });

  it("parses a plain JSON object with no prose", () => {
    const text = "{\"only\": true}";
    expect(extractJsonObject(text)).toEqual({ only: true });
  });

  it("returns null for text with no valid JSON", () => {
    expect(extractJsonObject("これはJSONではありません。")).toBeNull();
  });

  it("returns null for an unbalanced object", () => {
    expect(extractJsonObject("{\"a\": 1")).toBeNull();
  });
});
